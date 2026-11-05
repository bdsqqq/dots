import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import { record } from "../src/protocol.ts";
import { schemaPath } from "../src/discovery.ts";

export interface HarEntry {
  request: { url: string; postData?: { text?: string } };
  response: { content: { text?: string; encoding?: string } };
}
export interface SourceInventory {
  format: 1;
  harSha256: string;
  scripts: { path: string; sha256: string }[];
  paths: { path: string; source: string; offset: number }[];
  wireMethods: string[];
  endpoints: string[];
  frontendCommands: { method: string; source: string; offset: number }[];
  errorCodes: Record<string, number>;
  limits: string[];
}
export function readHar(path: string): HarEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new TypeError("HAR could not be read/parsed (capture contents omitted)");
  }
  if (!record(raw) || !record(raw.log) || !Array.isArray(raw.log.entries))
    throw new TypeError("expected HAR log.entries");
  const entries: HarEntry[] = [];
  for (const e of raw.log.entries) {
    if (
      !record(e) ||
      !record(e.request) ||
      typeof e.request.url !== "string" ||
      !record(e.response) ||
      !record(e.response.content)
    )
      throw new TypeError("malformed HAR entry");
    // Keep this adapter private to maintenance tooling, not the runtime SDK.
    entries.push(e as unknown as HarEntry);
  }
  return entries;
}
export function harRequest(entry: HarEntry): Record<string, unknown> | undefined {
  const text = entry.request.postData?.text;
  if (typeof text !== "string") return;
  try {
    const raw: unknown = JSON.parse(new URLSearchParams(text).get("req") ?? "null");
    if (record(raw) && record(raw.request)) return raw.request;
  } catch {
    /* Non-XMO requests are outside this inventory. */
  }
}
export function capturedCredentials(entries: HarEntry[]): { username: string; password: string } {
  const requests = entries.map(harRequest).filter(record);
  const actions = requests.flatMap((r) =>
    Array.isArray(r.actions) ? r.actions.filter(record) : [],
  );
  const login = actions.findLast(
    (a) => a.method === "logIn" && record(a.parameters) && typeof a.parameters.user === "string",
  );
  const username = record(login?.parameters) ? login.parameters.user : undefined;
  if (typeof username !== "string")
    throw new Error("HAR has no identified login; use explicit credentials");
  const passwordAction = actions.findLast(
    (a) =>
      a.method === "setValue" &&
      typeof a.xpath === "string" &&
      a.xpath.endsWith("/ClearTextPassword") &&
      a.xpath.includes(`[Login='${username}']`) &&
      record(a.parameters) &&
      typeof a.parameters.value === "string",
  );
  const password = record(passwordAction?.parameters) ? passwordAction.parameters.value : undefined;
  if (typeof password !== "string" || !password)
    throw new Error(
      "HAR has no matching administrator password assignment; use explicit credentials",
    );
  return { username, password };
}
export function sourceInventory(path: string, entries = readHar(path)): SourceInventory {
  const scripts = new Map<string, { path: string; sha256: string }>();
  const paths = new Map<string, { path: string; source: string; offset: number }>();
  const methods = new Set<string>();
  const endpoints = new Set<string>();
  const frontendCommands = new Map<string, { method: string; source: string; offset: number }>();
  const errorCodes = new Map<string, number>();
  const add = (literal: string, source: string, offset: number) => {
    const canonical = schemaPath(literal);
    // Only complete literal segments. Dynamic concatenations are not invented as endpoints.
    if (!/^Device(?:\/[A-Za-z_][\w:.-]*)*$/.test(canonical)) return;
    const key = canonical + "#" + source;
    if (!paths.has(key)) paths.set(key, { path: canonical, source, offset });
  };
  for (const [index, e] of entries.entries()) {
    let url: URL;
    try {
      url = new URL(e.request.url);
    } catch {
      throw new TypeError("HAR contains an invalid request URL (value omitted)");
    }
    if (url.hostname !== "192.168.0.1") continue;
    const request = harRequest(e);
    for (const a of Array.isArray(request?.actions) ? request.actions : [])
      if (record(a)) {
        if (typeof a.method === "string") methods.add(a.method);
        if (typeof a.xpath === "string") add(a.xpath, `log.entries[${index}].request`, 0);
      }
    const c = e.response.content;
    if (!url.pathname.endsWith(".js") || typeof c.text !== "string") continue;
    const bytes = c.encoding === "base64" ? Buffer.from(c.text, "base64") : Buffer.from(c.text);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const key = url.pathname + "#" + digest;
    if (scripts.has(key)) continue;
    scripts.set(key, { path: url.pathname, sha256: digest });
    const ast = ts.createSourceFile(
      url.pathname,
      bytes.toString("utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        add(node.text, url.pathname, node.getStart(ast));
        if (/^\/cgi\/[A-Za-z0-9_./-]+$/.test(node.text)) endpoints.add(node.text);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "remoteCall"
      ) {
        const method = node.arguments[1];
        if (method && ts.isStringLiteral(method)) {
          const key = method.text + "#" + url.pathname;
          if (!frontendCommands.has(key))
            frontendCommands.set(key, {
              method: method.text,
              source: url.pathname,
              offset: method.getStart(ast),
            });
        }
      }
      if (ts.isPropertyAssignment(node)) {
        const name =
          ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : "";
        if (name === "method" && ts.isStringLiteral(node.initializer))
          methods.add(node.initializer.text);
        if (/^XMO_[A-Z_]+$/.test(name) && ts.isNumericLiteral(node.initializer))
          errorCodes.set(name, Number(node.initializer.text));
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return {
    format: 1,
    harSha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    scripts: [...scripts.values()].sort((a, b) => a.path.localeCompare(b.path)),
    paths: [...paths.values()].sort(
      (a, b) => a.path.localeCompare(b.path) || a.source.localeCompare(b.source),
    ),
    wireMethods: [...methods].sort(),
    endpoints: [...endpoints].sort(),
    frontendCommands: [...frontendCommands.values()].sort(
      (a, b) => a.method.localeCompare(b.method) || a.source.localeCompare(b.source),
    ),
    errorCodes: Object.fromEntries([...errorCodes.entries()].sort()),
    limits: [
      "Literal XPath strings and observed request XPaths only; dynamic expressions and unvisited lazy chunks are not statically resolved.",
      "Selectors and credential values are removed. Source offsets refer to decoded JavaScript UTF-16 positions; HAR entries are zero-based.",
      "A path in shipped JavaScript may be unsupported or unauthorized on this firmware. Capability discovery records those outcomes separately.",
    ],
  };
}
