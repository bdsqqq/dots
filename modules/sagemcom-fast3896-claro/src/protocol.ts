/** JSON is retained verbatim: XMO enum numbers are often represented as names. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface XmoStatus {
  code: number;
  description: string;
}
export interface Capability {
  name?: string;
  type?: string;
  flags?: Record<string, boolean>;
  restrictions?: JsonObject;
  attributes?: Capability[];
  children?: Capability[];
  interfaces?: XmoInterface[];
  [key: string]: unknown;
}
export interface XmoInterface {
  name: string;
  commands: XmoCommand[];
  [key: string]: unknown;
}
export interface XmoCommand {
  name: string;
  "input-parameters"?: Capability[];
  "output-parameters"?: Capability[];
  [key: string]: unknown;
}
export interface ActionReply {
  id: number;
  error: XmoStatus;
  callbacks?: XmoCallback[];
  [key: string]: unknown;
}
export interface XmoCallback {
  result: XmoStatus;
  xpath?: string;
  parameters?: { value?: Json; capability?: Capability; [key: string]: unknown };
  [key: string]: unknown;
}
export interface Notification {
  id?: string | number;
  type?: string;
  xpath?: string;
  parameters?: { value?: Json; capability?: Capability; [key: string]: unknown };
  [key: string]: unknown;
}
export interface Reply {
  id?: number;
  error: XmoStatus;
  actions: ActionReply[];
  events?: Notification[];
  auth?: { token?: string };
  [key: string]: unknown;
}
/** Raw extension point. Convenience operations all reach the same validated boundary. */
export interface Action {
  method: string;
  xpath?: string;
  parameters?: JsonObject;
  options?: JsonObject;
  "event-id"?: string;
}
export interface WireRequest {
  request: {
    id: number;
    "session-id": string | number;
    priority: boolean;
    actions: (Action & { id: number })[];
    cnonce: number;
    "auth-key": string;
  };
}
export const REQUEST_OK = 16777216;
export const ACTION_OK = 16777238;
export const REQUEST_ACTION_ERROR = 16777236;
export const CALLBACK_ERROR = 16777248;
export const SESSION_ERRORS = new Set([16777219, 16777220, 16777221, 16777233]);

export class XmoError extends Error {
  readonly code: number;
  readonly layer: "request" | "action" | "callback";
  readonly actionId: number | undefined;
  /** May contain credentials or partial successes. Never log this indiscriminately. */
  declare readonly reply: Reply;
  constructor(status: XmoStatus, layer: XmoError["layer"], reply: Reply, actionId?: number) {
    // Descriptions/paths supplied by a router can contain secrets. Keep messages value-free.
    super(`router ${layer} failed (code ${status.code})`);
    this.name = "XmoError";
    this.code = status.code;
    this.layer = layer;
    this.actionId = actionId;
    Object.defineProperty(this, "reply", { value: reply, enumerable: false });
  }
}
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}
export class TransportError extends Error {
  readonly outcome: "not-confirmed" | "unknown";
  readonly httpStatus: number | undefined;
  constructor(mutating: boolean, httpStatus?: number) {
    super(
      mutating
        ? "router request failed; mutation outcome is unknown (do not blindly retry)"
        : "router transport failed",
    );
    this.name = "TransportError";
    this.outcome = mutating ? "unknown" : "not-confirmed";
    this.httpStatus = httpStatus;
  }
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isJson(value: unknown): value is Json {
  const ancestors = new Set<object>();
  const visit = (v: unknown, depth: number): boolean => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return true;
    if (typeof v === "number") return Number.isFinite(v);
    if (typeof v !== "object" || depth > 128 || ancestors.has(v)) return false;
    if (!Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v)))
      return false;
    if (Object.getOwnPropertySymbols(v).length) return false;
    if (
      Array.isArray(v) &&
      (Object.keys(v).length !== v.length ||
        Object.keys(v).some((k) => !/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= v.length))
    )
      return false;
    const descriptors = Object.getOwnPropertyDescriptors(v);
    ancestors.add(v);
    const valid = Object.entries(descriptors).every(
      ([key, d]) =>
        (Array.isArray(v) && key === "length") ||
        (d.enumerable && Object.hasOwn(d, "value") && visit(d.value, depth + 1)),
    );
    ancestors.delete(v);
    return valid;
  };
  return visit(value, 0);
}
export function validateActions(actions: readonly Action[]): void {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 90)
    throw new TypeError("a request needs 1–90 actions; batches are not transactions");
  for (const action of actions) {
    if (
      !record(action) ||
      !isJson(action) ||
      typeof action.method !== "string" ||
      !action.method.trim()
    )
      throw new TypeError("action must be plain JSON with a nonempty method");
    if (action.xpath !== undefined && (typeof action.xpath !== "string" || !action.xpath.trim()))
      throw new TypeError("xpath must be nonempty");
    for (const key of ["parameters", "options"] as const)
      if (action[key] !== undefined && (!record(action[key]) || !isJson(action[key])))
        throw new TypeError(`${key} must be a JSON object`);
    if (action["event-id"] !== undefined && typeof action["event-id"] !== "string")
      throw new TypeError("event-id must be a string");
    if (
      [
        "getValue",
        "getDefaultValue",
        "setValue",
        "addChild",
        "deleteChild",
        "subscribeForNotification",
      ].includes(action.method) &&
      !action.xpath
    )
      throw new TypeError("method requires an xpath");
    if (
      action.method === "setValue" &&
      (!record(action.parameters) || !Object.hasOwn(action.parameters, "value"))
    )
      throw new TypeError("setValue requires value (false, 0 and empty text are valid)");
    if (["logIn", "logOut"].includes(action.method))
      throw new TypeError("use login/logout to keep session state consistent");
  }
}
function status(value: unknown): value is XmoStatus {
  return record(value) && Number.isSafeInteger(value.code) && typeof value.description === "string";
}
/** Parse JSON or the JSON-in-HTML-body wrapper used by /cgi/upload; never return HTML as success. */
export function parseReply(text: string): Reply {
  let decoded: unknown;
  try {
    const trimmed = text.trim();
    if (trimmed.startsWith("<")) {
      const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(trimmed)?.[1];
      if (!body) throw new Error();
      decoded = JSON.parse(
        body
          .replace(/&quot;/g, '"')
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&"),
      );
    } else decoded = JSON.parse(trimmed);
  } catch {
    throw new ProtocolError("router returned a non-JSON reply");
  }
  if (!record(decoded) || !record(decoded.reply) || !status(decoded.reply.error))
    throw new ProtocolError("malformed router reply");
  const r = decoded.reply;
  if (r.actions === undefined) r.actions = [];
  if (!Array.isArray(r.actions)) throw new ProtocolError("malformed action replies");
  for (const a of r.actions) {
    if (!record(a) || !Number.isSafeInteger(a.id) || !status(a.error))
      throw new ProtocolError("malformed action reply");
    if (
      a.callbacks !== undefined &&
      (!Array.isArray(a.callbacks) ||
        !a.callbacks.every(
          (c) =>
            record(c) &&
            status(c.result) &&
            (c.parameters === undefined || record(c.parameters)) &&
            (c.xpath === undefined || typeof c.xpath === "string"),
        ))
    )
      throw new ProtocolError("malformed callbacks");
  }
  if (r.id !== undefined && !Number.isSafeInteger(r.id))
    throw new ProtocolError("malformed reply id");
  if (r.events !== undefined && (!Array.isArray(r.events) || !r.events.every(record)))
    throw new ProtocolError("malformed notifications");
  if (
    r.auth !== undefined &&
    (!record(r.auth) || (r.auth.token !== undefined && typeof r.auth.token !== "string"))
  )
    throw new ProtocolError("malformed authentication token");
  // The structural validation above is the transport trust boundary; extension fields remain unknown.
  return r as unknown as Reply;
}
export function checkReply(reply: Reply, expectedIds: readonly number[]): Reply {
  if (reply.error.code !== REQUEST_OK && reply.error.code !== REQUEST_ACTION_ERROR)
    throw new XmoError(reply.error, "request", reply);
  const seen = new Set<number>();
  for (const a of reply.actions) {
    if (!expectedIds.includes(a.id) || seen.has(a.id))
      throw new ProtocolError("unexpected/duplicate action id");
    seen.add(a.id);
    if (a.error.code !== ACTION_OK && a.error.code !== CALLBACK_ERROR)
      throw new XmoError(a.error, "action", reply, a.id);
    for (const c of a.callbacks ?? [])
      if (c.result.code !== ACTION_OK) throw new XmoError(c.result, "callback", reply, a.id);
    if (a.error.code === CALLBACK_ERROR) throw new XmoError(a.error, "action", reply, a.id);
  }
  if (seen.size !== expectedIds.length)
    throw new ProtocolError("incomplete action reply; outcome not confirmed");
  if (reply.error.code !== REQUEST_OK) throw new XmoError(reply.error, "request", reply);
  return reply;
}
export function callbacks(reply: Reply): XmoCallback[] {
  return [...reply.actions].sort((a, b) => a.id - b.id).flatMap((a) => a.callbacks ?? []);
}
export function firstCallback(reply: Reply): XmoCallback {
  const all = callbacks(reply);
  const callback = all[0];
  if (!callback) throw new ProtocolError("missing callback");
  return callback;
}
export function singleCallback(reply: Reply): XmoCallback {
  const all = callbacks(reply);
  if (all.length !== 1)
    throw new ProtocolError(
      "expected one callback; use readAll/readCallbacks for wildcard selections",
    );
  return all[0]!;
}
export function callbackValue(callback: XmoCallback): Json {
  if (
    !callback.parameters ||
    !Object.hasOwn(callback.parameters, "value") ||
    !isJson(callback.parameters.value)
  )
    throw new ProtocolError("missing/non-JSON callback value");
  return callback.parameters.value;
}
