const USER_AGENT = "anna/1.0 (+https://github.com/bdsqqq/dots)";
const TIMEOUT_MS = 15_000;
const MAX_COOKIE_HEADERS = 32;
const MAX_COOKIE_HEADER_BYTES = 4096;
const MAX_COOKIE_BYTES = 16_384;

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

function trustedOrigin(baseUrl: string): string {
  try {
    if (typeof baseUrl !== "string" || /[\s\x00-\x1f\x7f]/u.test(baseUrl) ||
        !/^https:\/\/[^/?#\\@]+\/?$/i.test(baseUrl)) throw new Error();
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new SessionError("Invalid search origin");
  }
}

async function cancel(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* Never expose server diagnostics. */ }
}

async function request(fetcher: typeof fetch, url: URL, init: RequestInit): Promise<Response> {
  try {
    return await fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    // Fetch errors can include the URL, request headers, or server diagnostics.
    throw new SessionError("Search transport failed");
  }
}

function sameOriginLocation(location: string, origin: string): boolean {
  try {
    return !/[\s\x00-\x1f\x7f]/u.test(location) &&
      new URL(location, origin + "/account/").origin === origin;
  } catch { return false; }
}

function hasForeignResponseUrl(response: Response, origin: string): boolean {
  // Synthetic test responses have no URL; native fetch responses must stay on-origin.
  if (!response.url) return false;
  try { return new URL(response.url).origin !== origin; } catch { return true; }
}

function sessionCookies(headers: Headers): string {
  const cookies = headers.getSetCookie();
  if (cookies.length === 0 || cookies.length > MAX_COOKIE_HEADERS) {
    throw new SessionError("Invalid session cookies");
  }
  let total = 0;
  let hasSession = false;
  const selected = new Map<string, string>();
  for (const header of cookies) {
    total += header.length;
    if (header.length > MAX_COOKIE_HEADER_BYTES || total > MAX_COOKIE_BYTES ||
        !/^[\x20-\x7e]+$/.test(header)) throw new SessionError("Invalid session cookies");
    const pair = header.split(";", 1)[0]!;
    const equal = pair.indexOf("=");
    const name = pair.slice(0, equal);
    const value = pair.slice(equal + 1);
    if (equal < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/.test(value)) {
      throw new SessionError("Invalid session cookies");
    }
    // Attributes are not forwarded: this jar is scoped to the explicitly trusted origin.
    if (!name.startsWith("aa_")) continue;
    if (!value || selected.has(name)) throw new SessionError("Invalid session cookies");
    selected.set(name, value);
    if (name === "aa_account_id2") hasSession = true;
  }
  if (!hasSession) throw new SessionError("Missing session cookie");
  return [...selected].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** Exchange the account key once; keep credentials in memory and never follow redirects. */
export async function createSearchSession(
  baseUrl: string,
  key: string,
  fetcher: typeof fetch = fetch,
): Promise<{ page(query: string, page: number): Promise<Response>; assertPublic(value: string): void }> {
  const origin = trustedOrigin(baseUrl);
  if (typeof key !== "string" || !key || key.length > 4096 || /[\s\x00-\x1f\x7f-\x9f]/u.test(key)) {
    throw new SessionError("Invalid account key");
  }
  const login = await request(fetcher, new URL("/account/", origin), {
    method: "POST",
    redirect: "manual",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ key }),
  });
  let cookie: string;
  try {
    if (![200, 302, 303].includes(login.status)) {
      throw new SessionError(`Login rejected (HTTP ${login.status})`);
    }
    const location = login.headers.get("location");
    if (login.redirected || hasForeignResponseUrl(login, origin) ||
        (location !== null && !sameOriginLocation(location, origin))) {
      throw new SessionError("Login redirect rejected");
    }
    cookie = sessionCookies(login.headers);
  } finally {
    await cancel(login);
  }

  // Successful HTML can reflect credentials too. Keep this guard beside the
  // cookie jar so callers can check output without ever receiving the cookie.
  const privateValues = [key, ...cookie.split("; ").map(pair => pair.slice(pair.indexOf("=") + 1))];
  const needles = privateValues.flatMap(value => [value, JSON.stringify(value).slice(1, -1)]);
  return {
    assertPublic(value: string): void {
      const decoded = value.replace(/(?:%[a-f0-9]{2})+/gi, part => {
        try { return decodeURIComponent(part); } catch { return part; }
      });
      if (needles.some(needle => value.includes(needle) || decoded.includes(needle))) {
        throw new SessionError("Private data in search results");
      }
    },
    async page(query: string, page: number): Promise<Response> {
      if (typeof query !== "string" || !Number.isInteger(page) || page < 1 || page > 5) {
        throw new SessionError("Invalid search parameters");
      }
      const url = new URL("/search", origin);
      url.searchParams.set("q", query);
      url.searchParams.set("page", String(page));
      const response = await request(fetcher, url, {
        method: "GET",
        redirect: "error",
        headers: { "User-Agent": USER_AGENT, Accept: "text/html", Cookie: cookie },
      });
      const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (response.status !== 200 || response.redirected ||
          hasForeignResponseUrl(response, origin) || mime !== "text/html") {
        await cancel(response);
        throw new SessionError(`Search response rejected (HTTP ${response.status})`);
      }
      return response;
    },
  };
}
