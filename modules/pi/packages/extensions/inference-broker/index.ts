import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Provider } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execute = promisify(execFile);
type Connection = { baseUrl: string; apiKey: string };

export function parseConnection(text: string): Connection {
  try {
    const value = JSON.parse(text) as Connection;
    const url = new URL(value.baseUrl);
    const loopback = url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
    if ((!loopback && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || !/^broker-[A-Za-z0-9_-]{43}$/.test(value.apiKey)) throw new Error();
    return { baseUrl: url.origin, apiKey: value.apiKey };
  } catch { throw new Error("invalid private broker connection"); }
}

async function connection(signal: AbortSignal): Promise<Connection> {
  try {
    // One read binds the key to its selected origin even while a user changes routes.
    const { stdout } = await execute("inference-broker", ["connection"], { signal, timeout: 5000, maxBuffer: 8192 });
    return parseConnection(stdout);
  } catch { throw new Error("broker connection unavailable; check its private client configuration"); }
}

/** Authentication owns the request-time endpoint; shared models.json owns only
 * catalog metadata. This prevents a laptop profile from retaining a remote URL.
 */
export function brokerProvider(load: (signal: AbortSignal) => Promise<Connection> = connection): Provider<"openai-responses"> {
  // The extension loader aliases package roots; use its supported compat entry
  // instead of an API subpath that jiti appends to compat.js.
  const responses = openAIResponsesApi();
  return {
    id: "cliproxyapi",
    name: "CLIProxyAPI · Codex",
    auth: { apiKey: {
      name: "managed broker connection",
      check: async () => {
        try {
          const path = process.env.CLI_PROXY_API_CLIENT_FILE || join(homedir(), ".config/cli-proxy-api/client.json");
          const info = await lstat(path);
          if (!info.isFile() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) return undefined;
          return { type: "api_key", source: "private broker client" };
        } catch { return undefined; }
      },
      resolve: async ({ signal }) => {
        const selected = await load(signal);
        return { auth: { apiKey: selected.apiKey, baseUrl: `${selected.baseUrl}/v1` }, source: "private broker client" };
      },
    } },
    getModels: () => [],
    stream: responses.stream,
    streamSimple: responses.streamSimple,
  };
}

export default function inferenceBroker(pi: ExtensionAPI): void {
  pi.registerProvider(brokerProvider());
}

if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest;
  const key = `broker-${"a".repeat(43)}`;
  it("allows only secure remote or numeric loopback broker origins", () => {
    expect(parseConnection(JSON.stringify({ baseUrl: "http://127.0.0.1:18317", apiKey: key })).baseUrl).toBe("http://127.0.0.1:18317");
    for (const baseUrl of ["http://remote.invalid", "http://localhost:18317", "https://user:secret@remote.invalid", "https://remote.invalid?key=secret"]) {
      expect(() => parseConnection(JSON.stringify({ baseUrl, apiKey: key }))).toThrow("invalid private broker connection");
    }
  });
  it("loads through the native SDK extension resolver", async () => {
    const { getPackageDir } = await import("@earendil-works/pi-coding-agent");
    const { fileURLToPath, pathToFileURL } = await import("node:url");
    const { loadExtensions } = await import(pathToFileURL(join(getPackageDir(), "dist/core/extensions/loader.js")).href);
    const paths = [fileURLToPath(import.meta.url)];
    if (process.env.PI_TEST_BUILT_TOOLS === "1") paths.push(fileURLToPath(new URL("../../../dist/extensions/inference-broker.js", import.meta.url)));
    for (const path of paths) {
      const loaded = await loadExtensions([path], process.cwd());
      expect(loaded.errors).toEqual([]);
      expect(loaded.runtime.pendingNativeProviderRegistrations.map((registration: { provider: { id: string } }) => registration.provider.id)).toContain("cliproxyapi");
    }
  });
  it("routes each native SDK request with its current origin/key pair, not catalog routing", async () => {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const { createServer } = await import("node:http");
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const seen: { target: string; authorization: string | undefined; path: string | undefined }[] = [];
    const servers = ["old", "selected"].map(target => createServer((request, response) => {
      seen.push({ target, authorization: request.headers.authorization, path: request.url });
      request.resume(); response.writeHead(422, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fixture response; routing only" } }));
    }));
    for (const server of servers) await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = (index: number) => `http://127.0.0.1:${(servers[index]!.address() as { port: number }).port}`;
    const root = await mkdtemp(join(tmpdir(), "pi-broker-wire-"));
    try {
      const path = join(root, "models.json");
      await writeFile(path, JSON.stringify({ providers: { cliproxyapi: {
        baseUrl: `${origin(0)}/v1`, api: "openai-responses", models: [{ id: "fixture" }],
      } } }));
      const runtime = await ModelRuntime.create({ modelsPath: path, authPath: join(root, "auth.json"), refreshOnCreate: false });
      let selected = { baseUrl: origin(1), apiKey: key };
      runtime.registerNativeProvider(brokerProvider(async () => selected));
      const model = runtime.getModel("cliproxyapi", "fixture")!;
      const context = { messages: [{ role: "user" as const, content: "routing fixture", timestamp: 0 }] };
      await runtime.streamSimple(model, context).result();
      expect(seen).toEqual([{ target: "selected", authorization: `Bearer ${key}`, path: "/v1/responses" }]);
      selected = { baseUrl: origin(0), apiKey: `broker-${"b".repeat(43)}` };
      await runtime.streamSimple(model, context).result();
      expect(seen[1]).toEqual({ target: "old", authorization: `Bearer ${selected.apiKey}`, path: "/v1/responses" });
      expect(seen).toHaveLength(2);
    } finally {
      await Promise.all(servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
      await rm(root, { recursive: true, force: true });
    }
  });

}
