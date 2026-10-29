import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Credentials {
  kid: string;
  secret: Buffer;
}
class MymindError extends Error {}
const API = "https://api.mymind.com";
const JSON_LIMIT = 1024 * 1024;
const MEDIA_LIMIT = 16 * 1024 * 1024;

function command(
  command: string,
  args: string[],
  env = process.env,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { env, timeout: 5000, maxBuffer: 64 * 1024, encoding: "utf8" },
      (error, stdout) => {
        // execFile errors can contain decrypted stdout.
        if (error)
          reject(
            new Error(
              "mymind credential command failed; check sops and the configured native age/SSH identity",
            ),
          );
        else resolve(stdout);
      },
    );
  });
}

async function credentialFile(): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      if (pkg.name === "@bdsqqq/pi") return join(dir, "../mymind/secrets.yaml");
    } catch {
      /* source and dist have different depths */
    }
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error(
        "mymind requires the live pi checkout beside modules/mymind",
      );
    dir = parent;
  }
}

function credentials(kid: string, encoded: string): Credentials {
  kid = kid.trim();
  encoded = encoded.trim();
  if (!kid || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw new Error("mymind managed credentials are malformed");
  const secret = Buffer.from(encoded, "base64");
  if (
    secret.length < 16 ||
    secret.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
  )
    throw new Error("mymind managed signing secret is not valid base64");
  return { kid, secret };
}

/** plain sops does not import the SSH identity used by sops-nix.
 * mirror modules/secrets/default.nix without persisting converted keys.
 */
export async function loadCredentials(): Promise<Credentials> {
  try {
    return credentials(
      await readFile("/run/secrets/mymind_keyid", "utf8"),
      await readFile("/run/secrets/mymind_privatekey", "utf8"),
    );
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        ["ENOENT", "EACCES"].includes(String(error.code))
      )
    )
      throw error;
  }
  const file = await credentialFile();
  let age = "";
  try {
    age = await readFile(join(homedir(), ".config/sops/age/keys.txt"), "utf8");
  } catch {
    /* SSH may be the configured matching identity */
  }
  try {
    age +=
      "\n" +
      (await command("ssh-to-age", [
        "-private-key",
        "-i",
        join(homedir(), ".ssh/id_ed25519"),
      ]));
  } catch {
    /* age key file may suffice */
  }
  if (!age.trim())
    throw new Error(
      "mymind: no readable configured native age identity; ask the owner to restore access",
    );
  const plain = await command(
    "sops",
    ["--decrypt", "--output-type", "json", file],
    { ...process.env, SOPS_AGE_KEY: age },
  );
  try {
    const data = JSON.parse(plain);
    return credentials(data.mymind_keyid, data.mymind_privatekey);
  } catch {
    throw new Error("mymind managed credentials are malformed");
  }
}

export function sign(
  path: string,
  key: Credentials,
  now: number = Date.now(),
): string {
  const iat = Math.floor(now / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", kid: key.kid }),
  ).toString("base64url");
  // the API binds JWTs to the pathname, excluding query parameters.
  const payload = Buffer.from(
    JSON.stringify({ method: "GET", path, iat, exp: iat + 60 }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  return `${data}.${createHmac("sha256", key.secret).update(data).digest("base64url")}`;
}

export function quota(headers: Headers): {
  cost: number | null;
  windows: { name: string; remaining: number; resetSeconds: number }[];
} {
  const windows = [
    ...(headers.get("ratelimit") ?? "").matchAll(
      /"(burst|sustained)"\s*;\s*r=(\d+)\s*;\s*t=(\d+)/g,
    ),
  ]
    .map((m) => ({
      name: m[1]!,
      remaining: Number(m[2]),
      resetSeconds: Number(m[3]),
    }))
    .filter(
      (w) =>
        Number.isSafeInteger(w.remaining) &&
        Number.isSafeInteger(w.resetSeconds),
    );
  const cost = headers.get("ratelimit-cost");
  return {
    cost:
      cost && /^\d+$/.test(cost) && Number.isSafeInteger(Number(cost))
        ? Number(cost)
        : null,
    windows,
  };
}

async function boundedBody(response: Response, max: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks);
      length += value.length;
      if (length > max)
        throw new MymindError(
          `mymind response exceeds ${max} byte limit; narrow the request or use a thumbnail`,
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function httpError(response: Response): Error {
  const status = response.status;
  const reset = Math.max(
    0,
    ...quota(response.headers)
      .windows.filter((w) => w.remaining === 0)
      .map((w) => w.resetSeconds),
  );
  const message =
    status === 401
      ? "authentication rejected; check managed key and system clock"
      : status === 403
        ? "key lacks permission for this action or scope"
        : status === 404
          ? "object not found or outside key scope"
          : status === 422
            ? "object does not support this media/content variant"
            : status === 429
              ? `quota exhausted; ${reset ? `retry after ${reset} seconds` : "wait for a quota reset (reset headers unavailable)"}; no automatic retry`
              : "request failed; check API availability and query";
  return new MymindError(`mymind HTTP ${status}: ${message}`);
}

export function objectPath(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
    throw new Error(
      "mymind id must be an object identifier, not a URL or path",
    );
  return `/objects/${id}`;
}

export function searchParams(q: string, limit = 10): URLSearchParams {
  if (
    !q.trim() ||
    q.length > 1024 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new Error(
      "mymind query must be 1–1024 characters; limit must be 1–50",
    );
  return new URLSearchParams({ q, limit: String(limit) });
}

type Dependencies = {
  fetch: typeof fetch;
  credentials: () => Promise<Credentials>;
};
export class MymindClient {
  private deps: Dependencies;
  constructor(deps: Partial<Dependencies> = {}) {
    this.deps = {
      fetch: globalThis.fetch,
      credentials: loadCredentials,
      ...deps,
    };
  }

  private async request(
    path: string,
    params: URLSearchParams,
    media: boolean,
    signal?: AbortSignal,
  ): Promise<{
    bytes: Buffer;
    mimeType: string;
    quota: ReturnType<typeof quota>;
  }> {
    const key = await this.deps.credentials();
    const deadline = AbortSignal.timeout(20_000);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let url = new URL(path, API);
    url.search = params.toString();
    let auth = true;
    let usage: ReturnType<typeof quota> = { cost: null, windows: [] };
    try {
      for (let redirects = 0; ; redirects++) {
        const response = await this.deps.fetch(url, {
          method: "GET",
          redirect: "manual",
          signal: combined,
          headers: {
            "User-Agent": "pi-mymind/1.0",
            Accept: media ? "*/*" : "application/json",
            ...(auth
              ? { Authorization: `Bearer ${sign(url.pathname, key)}` }
              : {}),
          },
        });
        if (auth) usage = quota(response.headers);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!media || redirects >= 3 || !location)
            throw new MymindError(
              "mymind unsafe or excessive redirect refused",
            );
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            throw new MymindError("mymind invalid media redirect");
          }
          // docs name mymind.media; live responses also use media.mymind.host.
          if (
            next.protocol !== "https:" ||
            next.port ||
            next.username ||
            next.password ||
            !(
              next.hostname === "media.mymind.host" ||
              next.hostname === "mymind.media" ||
              next.hostname.endsWith(".mymind.media")
            )
          )
            throw new MymindError("mymind unapproved media redirect refused");
          url = next;
          auth = false; // API credentials must not reach the CDN.
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw httpError(response);
        }
        const bytes = await boundedBody(
          response,
          media ? MEDIA_LIMIT : JSON_LIMIT,
        );
        return {
          bytes,
          mimeType: (
            response.headers.get("content-type") ?? "application/octet-stream"
          )
            .split(";")[0]!
            .trim(),
          quota: usage,
        };
      }
    } catch (error) {
      if (combined.aborted)
        throw new Error("mymind request cancelled or timed out (20s)");
      // network errors can contain signed URLs.
      if (error instanceof MymindError) throw error;
      throw new Error(
        "mymind network request failed (details withheld to protect signed URLs)",
      );
    }
  }

  async search(
    q: string,
    limit = 10,
    matchesOnly = false,
    signal?: AbortSignal,
  ): Promise<{ data: Json; quota: ReturnType<typeof quota> }> {
    const params = searchParams(q, limit);
    if (!matchesOnly) params.set("contentAs", "text/markdown");
    return this.json(matchesOnly ? "/search" : "/objects", params, signal);
  }

  async object(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ data: Json; quota: ReturnType<typeof quota> }> {
    return this.json(
      objectPath(id),
      new URLSearchParams({ contentAs: "text/markdown" }),
      signal,
    );
  }

  private async json(
    path: string,
    params: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<{ data: Json; quota: ReturnType<typeof quota> }> {
    const response = await this.request(path, params, false, signal);
    try {
      return {
        data: JSON.parse(response.bytes.toString("utf8")),
        quota: response.quota,
      };
    } catch {
      throw new Error("mymind returned invalid JSON");
    }
  }

  async media(
    id: string,
    variant: "blob" | "screenshot" | "thumbnail" = "thumbnail",
    size?: string,
    signal?: AbortSignal,
  ): Promise<{
    path: string;
    mimeType: string;
    bytes: number;
    quota: ReturnType<typeof quota>;
  }> {
    if (!["blob", "screenshot", "thumbnail"].includes(variant))
      throw new Error("mymind invalid media variant");
    if (
      size !== undefined &&
      (variant !== "thumbnail" || !/^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(size))
    )
      throw new Error(
        "mymind size requires a thumbnail containment box, 1–9999 per dimension",
      );
    const response = await this.request(
      `${objectPath(id)}/${variant}`,
      new URLSearchParams(size ? { size } : {}),
      true,
      signal,
    );
    const extension =
      (
        {
          "image/png": ".png",
          "image/jpeg": ".jpg",
          "image/webp": ".webp",
          "image/gif": ".gif",
          "application/pdf": ".pdf",
          "video/mp4": ".mp4",
        } as Record<string, string>
      )[response.mimeType] ?? ".bin";
    const dir = await mkdtemp(join(tmpdir(), "pi-mymind-"));
    const path = join(dir, `${id}-${variant}${extension}`);
    await writeFile(path, response.bytes, { mode: 0o600, flag: "wx" });
    return {
      path,
      mimeType: response.mimeType,
      bytes: response.bytes.length,
      quota: response.quota,
    };
  }
}

if (import.meta.vitest) {
  const { it, expect, vi, afterEach } = import.meta.vitest;
  const key = credentials(
    "fixture-key",
    Buffer.from("fixture-secret-16-bytes").toString("base64"),
  );
  const make = (fetcher: typeof fetch) =>
    new MymindClient({ fetch: fetcher, credentials: async () => key });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("signs HS256 using decoded base64, pathname, uppercase method and short expiry", () => {
    const token = sign("/objects/abc", key, 1_700_000_000_000);
    const [head, body, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(head!, "base64url").toString())).toEqual({
      alg: "HS256",
      kid: "fixture-key",
    });
    expect(JSON.parse(Buffer.from(body!, "base64url").toString())).toEqual({
      path: "/objects/abc",
      method: "GET",
      iat: 1700000000,
      exp: 1700000060,
    });
    expect(signature).toBe(
      createHmac("sha256", Buffer.from("fixture-secret-16-bytes"))
        .update(`${head}.${body}`)
        .digest("base64url"),
    );
    expect(sign("/objects/abc", key, 1_700_000_001_000)).not.toBe(token);
    expect(() => credentials("id", "%%%")).toThrow("malformed");
  });

  it("encodes bounded queries, defaults to 10, supports matches and markdown retrieval", async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const client = make(async (input, init) => {
      calls.push({
        url: new URL(input instanceof Request ? input.url : input),
        init: init!,
      });
      return new Response(
        JSON.stringify([{ id: "abc", content: { body: "reference" } }]),
        { headers: { "RateLimit-Cost": "1" } },
      );
    });
    expect(
      (await client.search('type:image && tag:"design tools"')).data,
    ).toEqual([{ id: "abc", content: { body: "reference" } }]);
    await client.search("design", 2, true);
    await client.object("abc");
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/objects",
      "/search",
      "/objects/abc",
    ]);
    expect(calls[0]!.url.searchParams.get("q")).toBe(
      'type:image && tag:"design tools"',
    );
    expect(calls[0]!.url.searchParams.get("limit")).toBe("10");
    expect(calls[1]!.url.searchParams.get("limit")).toBe("2");
    expect(calls[2]!.url.searchParams.get("contentAs")).toBe("text/markdown");
    for (const { url, init } of calls) {
      const token = new Headers(init.headers).get("authorization")!.slice(7);
      expect(
        JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString())
          .path,
      ).toBe(url.pathname);
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("manual");
    }
    for (const limit of [0, 51, 1.5, Infinity])
      await expect(client.search("design", limit)).rejects.toThrow("limit");
    await expect(client.search(" ")).rejects.toThrow("query");
    await expect(client.search("a".repeat(1025))).rejects.toThrow("query");
    await expect(client.object("../secrets")).rejects.toThrow("identifier");
    await expect(client.media("abc", "blob", "100x100")).rejects.toThrow(
      "size",
    );
    expect(calls).toHaveLength(3);
  });

  it.each(["blob", "screenshot", "thumbnail"] as const)(
    "uses the documented %s route",
    async (variant) => {
      const fs = await import("node:fs/promises");
      const fetcher = vi.fn<typeof fetch>(
        async () =>
          new Response("media", { headers: { "content-type": "image/jpeg" } }),
      );
      const result = await make(fetcher).media("abc", variant);
      try {
        const url = fetcher.mock.calls[0]![0];
        expect(url instanceof URL ? url.href : url).toBe(
          `https://api.mymind.com/objects/abc/${variant}`,
        );
        expect(result.path.endsWith(".jpg")).toBe(true);
      } finally {
        await fs.rm(dirname(result.path), { recursive: true });
      }
    },
  );

  it("reports quota without guessing missing headers or waiting on non-exhausted windows", () => {
    expect(quota(new Headers())).toEqual({ cost: null, windows: [] });
    const headers = new Headers({
      RateLimit: '"burst"; r=0; t=300, "sustained";r=100;t=99999',
      "RateLimit-Cost": "2",
    });
    expect(quota(headers).windows).toHaveLength(2);
    expect(
      httpError(new Response(null, { status: 429, headers })).message,
    ).toContain("300 seconds");
    expect(httpError(new Response(null, { status: 429 })).message).toContain(
      "headers unavailable",
    );
  });

  it("downloads CDN bytes privately without forwarding auth or returning signed locations", async () => {
    const fs = await import("node:fs/promises");
    const calls: RequestInit[] = [];
    const client = make(async (_url, init) => {
      calls.push(init!);
      if (calls.length === 1)
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://media.mymind.host/ref?signature=private",
            "RateLimit-Cost": "2",
          },
        });
      if (calls.length === 2)
        return new Response(null, {
          status: 307,
          headers: {
            location: "https://cdn.mymind.media/ref?signature=private",
          },
        });
      return new Response("fixture bytes", {
        headers: { "content-type": "image/png" },
      });
    });
    const result = await client.media("abc", "thumbnail", "640x480");
    try {
      expect(await fs.readFile(result.path, "utf8")).toBe("fixture bytes");
      expect((await fs.stat(result.path)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(dirname(result.path))).mode & 0o777).toBe(0o700);
      expect(result.quota.cost).toBe(2);
      expect(new Headers(calls[0]!.headers).has("authorization")).toBe(true);
      expect(
        calls
          .slice(1)
          .every((c) => !new Headers(c.headers).has("authorization")),
      ).toBe(true);
      expect(JSON.stringify(result)).not.toContain("signature");
    } finally {
      await fs.rm(dirname(result.path), { recursive: true });
    }
  });

  it.each([
    "http://mymind.media/a",
    "https://mymind.media.evil.test/a",
    "https://127.0.0.1/a",
    "https://mymind.media:444/a",
    "https://user:pass@mymind.media/a",
    "https://api.mymind.com/objects/abc",
    "file:///tmp/a",
  ])("refuses unsafe redirect %s before a second request", async (location) => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 302, headers: { location } }),
    );
    await expect(make(fetcher).media("abc")).rejects.toThrow(
      "redirect refused",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refuses JSON redirects and caps CDN redirect loops", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://mymind.media/a" },
        }),
    );
    await expect(make(fetcher).object("abc")).rejects.toThrow(
      "redirect refused",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockClear();
    await expect(make(fetcher).media("abc")).rejects.toThrow(
      "excessive redirect",
    );
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([
    [401, "authentication"],
    [403, "permission"],
    [404, "scope"],
    [422, "variant"],
    [429, "900 seconds"],
    [503, "availability"],
  ])("sanitizes HTTP %s and does not retry", async (status, message) => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response("reflected bearer secret", {
          status: Number(status),
          headers: { RateLimit: '"burst";r=0;t=300, "sustained";r=0;t=900' },
        }),
    );
    const error = await make(fetcher)
      .object("abc")
      .catch((e: Error) => e);
    if (!(error instanceof Error)) throw new Error("expected an HTTP failure");
    expect(error.message).toContain(message);
    expect(error.message).not.toContain("secret");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bounds streamed bodies even without content-length and cancels oversized streams", async () => {
    const cancel = vi.fn();
    const fetcher: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(JSON_LIMIT + 1));
          },
          cancel,
        }),
      );
    await expect(make(fetcher).object("abc")).rejects.toThrow("byte limit");
    expect(cancel).toHaveBeenCalledOnce();
    await expect(
      make(async () => new Response(new Uint8Array(MEDIA_LIMIT + 1))).media(
        "abc",
      ),
    ).rejects.toThrow("byte limit");
    await expect(
      make(async () => new Response("not json")).object("abc"),
    ).rejects.toThrow("invalid JSON");
  });

  it("bounds request time, propagates cancellation and sanitizes network errors", async () => {
    vi.useFakeTimers();
    const fetcher: typeof fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        if (init!.signal!.aborted) reject(new Error("private CDN URL"));
        else
          init!.signal!.addEventListener(
            "abort",
            () => reject(new Error("private CDN URL")),
            { once: true },
          );
      });
    const controller = new AbortController();
    controller.abort();
    await expect(
      make(fetcher).object("abc", controller.signal),
    ).rejects.toThrow("cancelled or timed out");
    await expect(
      make(async () => {
        throw new Error("mymind https://mymind.media/?private");
      }).object("abc"),
    ).rejects.toThrow("details withheld");
    // Native AbortSignal.timeout does not use vitest's fake JS timers.
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    await expect(make(fetcher).object("abc")).rejects.toThrow("timed out");
    expect(timeout).toHaveBeenCalledWith(20_000);
  });
}
