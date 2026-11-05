import { createHash, randomInt } from "node:crypto";
import {
  XmoError,
  ProtocolError,
  TransportError,
  SESSION_ERRORS,
  validateActions,
  parseReply,
  checkReply,
  singleCallback,
  callbackValue,
  record,
  isJson,
} from "./protocol.ts";
import type {
  Action,
  Capability,
  Json,
  JsonObject,
  Reply,
  WireRequest,
  XmoCallback,
  Notification,
} from "./protocol.ts";

export type HashAlgorithm = "sha512" | "md5";
export type Session = {
  id: string | number;
  nextRequestId: number;
} & (
  | {
      mode: "digest";
      username: string;
      nonce: string;
      passwordHash: string;
      algorithm: HashAlgorithm;
    }
  | { mode: "token"; token: string }
);
export type Authentication =
  | {
      mode: "credentials";
      username: string;
      password: string;
      algorithm?: HashAlgorithm;
      salt?: string;
      sessionOptions?: JsonObject;
    }
  | { mode: "session"; session: Session };
export interface ClientOptions {
  baseUrl?: string;
  auth: Authentication;
  /** Read-only by default. Also gates arbitrary remote commands and multipart uploads. */
  allowMutations?: boolean;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  priority?: boolean;
}
export interface UploadFile {
  field: string;
  filename: string;
  data: Blob;
}
export interface ReadResult {
  value: Json;
  capability: Capability | undefined;
  xpath: string | undefined;
}
export type Subscription =
  | { type: "periodic"; timer: number; currentValue?: boolean }
  | { type: "value-change" | "add-child" | "global"; currentValue?: boolean; timer?: never }
  | { type: "delete-child" | "delete-element"; currentValue?: never; timer?: never };
const nonMutating = new Set([
  "getValue",
  "getDefaultValue",
  "subscribeForNotification",
  "unsubscribeForNotification",
  "getEvents",
  "resetEvents",
]);
const hash = (text: string, algorithm: HashAlgorithm) =>
  createHash(algorithm).update(text).digest("hex");
const uint32 = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff;

export function validateSession(raw: unknown): Session {
  if (
    !record(raw) ||
    !(
      (typeof raw.id === "string" && raw.id !== "" && raw.id !== "0") ||
      (uint32(raw.id) && raw.id !== 0)
    ) ||
    !uint32(raw.nextRequestId)
  )
    throw new TypeError("invalid session identity/request counter");
  if (
    raw.mode === "digest" &&
    typeof raw.username === "string" &&
    typeof raw.nonce === "string" &&
    (raw.algorithm === "sha512" || raw.algorithm === "md5") &&
    typeof raw.passwordHash === "string" &&
    new RegExp(`^[a-f0-9]{${raw.algorithm === "sha512" ? 128 : 32}}$`, "i").test(raw.passwordHash)
  ) {
    return {
      mode: "digest",
      id: raw.id,
      nextRequestId: raw.nextRequestId,
      username: raw.username,
      nonce: raw.nonce,
      algorithm: raw.algorithm,
      passwordHash: raw.passwordHash,
    };
  }
  if (raw.mode === "token" && typeof raw.token === "string" && raw.token.length > 0)
    return { mode: "token", id: raw.id, nextRequestId: raw.nextRequestId, token: raw.token };
  throw new TypeError("invalid session authentication");
}
/** Explicit cookie import; a session is a credential. No browser/cookie store is read automatically. */
export function sessionFromCookie(text: string, algorithm: HashAlgorithm = "sha512"): Session {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TypeError("session cookie must be decoded JSON");
  }
  if (!record(raw) || raw.basic === true) throw new TypeError("unsupported/invalid session cookie");
  const common = { id: raw.sess_id, nextRequestId: raw.req_id };
  if (typeof raw.authToken === "string" && raw.authToken)
    return validateSession({ ...common, mode: "token", token: raw.authToken });
  if (typeof raw.ha1 !== "string" || raw.ha1.length !== (algorithm === "sha512" ? 256 : 64))
    throw new TypeError("invalid digest cookie");
  return validateSession({
    ...common,
    mode: "digest",
    username: raw.user,
    nonce: raw.nonce,
    algorithm,
    passwordHash: raw.ha1.slice(10, 10 + (algorithm === "sha512" ? 128 : 32)),
  });
}

/** Node-only client. No background polling, implicit discovery, automatic retries, or process-global auth. */
export class SagemcomXmoClient {
  readonly baseUrl: string;
  readonly allowMutations: boolean;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeout: number;
  readonly #auth: Authentication;
  #session: Session | undefined;
  #login: Promise<void> | undefined;
  #subscriptionId = 0;
  constructor(options: ClientOptions) {
    let url: URL;
    try {
      url = new URL(options.baseUrl ?? "http://192.168.0.1");
    } catch {
      throw new TypeError("baseUrl must be a valid HTTP(S) origin");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new TypeError("baseUrl must be an HTTP(S) origin without credentials/path/query");
    if (!record(options.auth) || !["credentials", "session"].includes(options.auth.mode))
      throw new TypeError("auth is required");
    this.baseUrl = url.origin;
    this.#auth = structuredClone(options.auth);
    if (this.#auth.mode === "session") this.#session = validateSession(this.#auth.session);
    else {
      if (
        typeof this.#auth.username !== "string" ||
        !this.#auth.username.trim() ||
        typeof this.#auth.password !== "string" ||
        !this.#auth.password
      )
        throw new TypeError("username and password are required");
      if (
        this.#auth.sessionOptions !== undefined &&
        (!record(this.#auth.sessionOptions) || !isJson(this.#auth.sessionOptions))
      )
        throw new TypeError("sessionOptions must be a JSON object");
      if (this.#auth.algorithm !== undefined && !["sha512", "md5"].includes(this.#auth.algorithm))
        throw new TypeError("unsupported hash algorithm");
      if (this.#auth.salt !== undefined && typeof this.#auth.salt !== "string")
        throw new TypeError("salt must be text");
    }
    this.allowMutations = options.allowMutations ?? false;
    if (typeof this.allowMutations !== "boolean")
      throw new TypeError("allowMutations must be boolean");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = options.timeoutMs ?? 30_000;
    this.#validateTimeout(this.#timeout);
  }
  get connected(): boolean {
    return this.#session !== undefined;
  }
  /** Opt-in secret export. Callers own persistence/permissions; credentials are never auto-saved. */
  exportSession(): Session {
    if (!this.#session) throw new Error("not authenticated");
    return structuredClone(this.#session);
  }
  async login(options: RequestOptions = {}): Promise<void> {
    const signal = this.#signal(options);
    signal.throwIfAborted();
    if (this.#session) return;
    if (this.#login) return this.#waitForLogin(this.#login, signal);
    if (this.#auth.mode !== "credentials")
      throw new Error("session expired; supply a new session or a credentials client");
    const auth = this.#auth;
    const pending: Promise<void> = (async () => {
      const algorithm = auth.algorithm ?? "sha512";
      const passwordHash = hash(auth.password + (auth.salt ? `:${auth.salt}` : ""), algorithm);
      const initial: Session = {
        mode: "digest",
        id: "0",
        nextRequestId: 0,
        username: auth.username,
        nonce: "",
        passwordHash,
        algorithm,
      };
      const sessionOptions: JsonObject = {
        nss: [{ name: "gtw", uri: "http://sagemcom.com/gateway-data" }],
        "context-flags": { "get-content-name": true, "local-time": true },
        "capability-depth": 2,
        "capability-flags": {
          name: true,
          "default-value": false,
          restriction: true,
          description: false,
        },
        "time-format": "ISO_8601",
        "jwt-auth": "true",
        ...auth.sessionOptions,
      };
      const reply = await this.#send(
        [
          {
            method: "logIn",
            parameters: {
              user: auth.username,
              persistent: "true",
              "session-options": sessionOptions,
            },
          },
        ],
        initial,
        { ...options, signal },
      );
      const p = singleCallback(reply).parameters;
      if (
        !p ||
        !((typeof p.id === "string" && p.id !== "" && p.id !== "0") || (uint32(p.id) && p.id !== 0))
      )
        throw new ProtocolError("login did not return a session id");
      const token = reply.auth?.token;
      this.#session = token
        ? validateSession({ mode: "token", id: p.id, token, nextRequestId: initial.nextRequestId })
        : validateSession({ ...initial, id: p.id, nonce: p.nonce });
    })().finally(() => {
      if (this.#login === pending) this.#login = undefined;
    });
    this.#login = pending;
    return this.#waitForLogin(pending, signal);
  }
  async logout(options: RequestOptions = {}): Promise<void> {
    const signal = this.#signal(options);
    signal.throwIfAborted();
    if (this.#login) await this.#waitForLogin(this.#login, signal);
    if (!this.#session) return;
    try {
      await this.#send([{ method: "logOut" }], this.#session, { ...options, signal });
    } finally {
      this.#session = undefined;
    }
  }
  /** A single wire batch (max 90 actions), NOT an atomic transaction. Errors retain partial replies. */
  async execute(actions: readonly Action[], options: RequestOptions = {}): Promise<Reply> {
    validateActions(actions);
    const snapshot = structuredClone(actions);
    this.#requirePermission(snapshot);
    await this.login(options);
    const session = this.#session;
    if (!session) throw new Error("not authenticated");
    return this.#send(snapshot, session, options);
  }
  async read(
    xpath: string,
    sessionOptions?: JsonObject,
    options?: RequestOptions,
  ): Promise<ReadResult> {
    const c = singleCallback(
      await this.execute(
        [
          {
            method: "getValue",
            xpath,
            ...(sessionOptions === undefined ? {} : { options: sessionOptions }),
          },
        ],
        options,
      ),
    );
    return { value: callbackValue(c), capability: c.parameters?.capability, xpath: c.xpath };
  }
  async get(xpath: string, options?: RequestOptions): Promise<Json> {
    return (await this.read(xpath, undefined, options)).value;
  }
  async readAll(
    xpath: string,
    sessionOptions?: JsonObject,
    options?: RequestOptions,
  ): Promise<ReadResult[]> {
    return readCallbacks(
      await this.execute(
        [
          {
            method: "getValue",
            xpath,
            ...(sessionOptions === undefined ? {} : { options: sessionOptions }),
          },
        ],
        options,
      ),
    );
  }
  async getDefault(xpath: string, options?: RequestOptions): Promise<Json> {
    return callbackValue(
      singleCallback(await this.execute([{ method: "getDefaultValue", xpath }], options)),
    );
  }
  set(xpath: string, value: Json, options?: RequestOptions): Promise<Reply> {
    return this.execute([{ method: "setValue", xpath, parameters: { value } }], options);
  }
  add(
    xpath: string,
    value?: Json,
    extra: { uid?: string | number; childType?: string } = {},
    options?: RequestOptions,
  ): Promise<Reply> {
    const parameters: JsonObject = {};
    if (extra.uid !== undefined) parameters.uid = extra.uid;
    if (value !== undefined)
      parameters.value = extra.childType === undefined ? value : { [extra.childType]: value };
    return this.execute([{ method: "addChild", xpath, parameters }], options);
  }
  delete(xpath: string, options?: RequestOptions): Promise<Reply> {
    return this.execute([{ method: "deleteChild", xpath }], options);
  }
  /** Full remote-command escape hatch. Capability discovery is explicit, never a hidden fetch. */
  call(
    xpath: string,
    method: string,
    parameters?: JsonObject,
    options?: RequestOptions,
    eventId?: string,
  ): Promise<Reply> {
    return this.execute(
      [
        {
          method,
          xpath,
          ...(parameters === undefined ? {} : { parameters }),
          ...(eventId === undefined ? {} : { "event-id": eventId }),
        },
      ],
      options,
    );
  }
  node(xpath: string) {
    return {
      get: (options?: RequestOptions) => this.get(xpath, options),
      read: (sessionOptions?: JsonObject, options?: RequestOptions) =>
        this.read(xpath, sessionOptions, options),
      readAll: (sessionOptions?: JsonObject, options?: RequestOptions) =>
        this.readAll(xpath, sessionOptions, options),
      set: (value: Json, options?: RequestOptions) => this.set(xpath, value, options),
      getDefault: (options?: RequestOptions) => this.getDefault(xpath, options),
      add: (
        value?: Json,
        extra?: { uid?: string | number; childType?: string },
        options?: RequestOptions,
      ) => this.add(xpath, value, extra, options),
      delete: (options?: RequestOptions) => this.delete(xpath, options),
      call: (method: string, parameters?: JsonObject, options?: RequestOptions) =>
        this.call(xpath, method, parameters, options),
    };
  }
  /** Caller owns each subscription; no shared/global event loop is installed. */
  readonly events = {
    subscribe: async (
      xpath: string,
      subscription: Subscription,
      options?: RequestOptions,
    ): Promise<string> => {
      if (
        !record(subscription) ||
        ![
          "value-change",
          "periodic",
          "add-child",
          "delete-child",
          "global",
          "delete-element",
        ].includes(subscription.type)
      )
        throw new TypeError("unknown notification type");
      if (
        subscription.type === "periodic" &&
        (!Number.isFinite(subscription.timer) || subscription.timer <= 0)
      )
        throw new TypeError("periodic timer must be positive seconds");
      if (subscription.currentValue !== undefined && typeof subscription.currentValue !== "boolean")
        throw new TypeError("currentValue must be boolean");
      const id = String(++this.#subscriptionId);
      const parameters: JsonObject = { id, type: subscription.type };
      if (subscription.type === "periodic") parameters.timer = subscription.timer;
      if (subscription.currentValue !== undefined)
        parameters["current-value"] = subscription.currentValue;
      await this.execute([{ method: "subscribeForNotification", xpath, parameters }], options);
      return id;
    },
    unsubscribe: (id: string, options?: RequestOptions): Promise<Reply> => {
      if (typeof id !== "string" || !id) throw new TypeError("subscription id is required");
      return this.execute([{ method: "unsubscribeForNotification", parameters: { id } }], options);
    },
    poll: async (options?: RequestOptions): Promise<Notification[]> =>
      (await this.execute([{ method: "getEvents" }], options)).events ?? [],
    reset: (options?: RequestOptions): Promise<Reply> =>
      this.execute([{ method: "resetEvents" }], options),
  };
  /** Multipart fields are declared by the caller; the command determines restore/firmware semantics. */
  async upload(
    actions: readonly Action[],
    files: readonly UploadFile[],
    options: RequestOptions = {},
  ): Promise<Reply> {
    validateActions(actions);
    if (!this.allowMutations)
      throw new Error("mutations disabled; construct with allowMutations: true");
    if (
      !Array.isArray(files) ||
      !files.length ||
      files.some(
        (f) =>
          typeof f.field !== "string" ||
          !f.field ||
          f.field === "req" ||
          typeof f.filename !== "string" ||
          !f.filename ||
          !(f.data instanceof Blob),
      )
    )
      throw new TypeError("upload needs named Blob files (req is reserved)");
    if (new Set(files.map((f) => f.field)).size !== files.length)
      throw new TypeError("duplicate upload field");
    const snapshot = structuredClone(actions);
    await this.login(options);
    if (!this.#session) throw new Error("not authenticated");
    return this.#send(snapshot, this.#session, options, files);
  }
  /** Only downloads a URI returned by an explicit command; never follows a cross-origin redirect. */
  async download(uri: string, options: RequestOptions = {}): Promise<Blob> {
    let url: URL;
    try {
      url = new URL(uri, this.baseUrl);
    } catch {
      throw new TypeError("download URI must be a valid router URL");
    }
    if (url.origin !== this.baseUrl || url.username || url.password)
      throw new TypeError("download URI must have the router's origin");
    const signal = this.#signal(options);
    let response: Response;
    try {
      response = await this.#fetch(url, { signal, redirect: "error" });
    } catch {
      throw new TransportError(false);
    }
    if (!response.ok) throw new TransportError(false, response.status);
    try {
      const blob = await response.blob();
      signal.throwIfAborted();
      return blob;
    } catch {
      throw new TransportError(false);
    }
  }
  #waitForLogin(pending: Promise<void>, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      const cleanup = () => signal.removeEventListener("abort", abort);
      // Observe the owned promise even if a synchronous injected fetch aborted its caller.
      pending.then(
        () => {
          cleanup();
          resolve();
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  #requirePermission(actions: readonly Action[]) {
    if (!this.allowMutations && actions.some((a) => !nonMutating.has(a.method)))
      throw new Error("mutations disabled; construct with allowMutations: true");
  }
  #validateTimeout(ms: number) {
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > 0x7fffffff)
      throw new TypeError("timeoutMs must be 1–2147483647");
  }
  #signal(options: RequestOptions): AbortSignal {
    if (options.priority !== undefined && typeof options.priority !== "boolean")
      throw new TypeError("priority must be boolean");
    const timeout = options.timeoutMs ?? this.#timeout;
    this.#validateTimeout(timeout);
    const signals = [AbortSignal.timeout(timeout)];
    if (options.signal) signals.push(options.signal);
    return AbortSignal.any(signals);
  }
  async #send(
    actions: readonly Action[],
    session: Session,
    options: RequestOptions,
    files?: readonly UploadFile[],
  ): Promise<Reply> {
    const signal = this.#signal(options);
    signal.throwIfAborted();
    const id = session.nextRequestId++;
    if (session.nextRequestId > 0xffffffff) session.nextRequestId = 1;
    const cnonce = randomInt(0, 0xffffffff);
    const authKey =
      session.mode === "token"
        ? session.token
        : hash(
            `${hash(`${session.username}:${session.nonce}:${session.passwordHash}`, session.algorithm)}:${id}:${cnonce}:JSON:/cgi/json-req`,
            session.algorithm,
          );
    const wire: WireRequest = {
      request: {
        id,
        "session-id": session.id,
        priority: options.priority ?? false,
        actions: actions.map((a, id) => ({ ...a, id })),
        cnonce,
        "auth-key": authKey,
      },
    };
    let body: URLSearchParams | FormData = new URLSearchParams({ req: JSON.stringify(wire) });
    if (files) {
      body = new FormData();
      body.append("req", JSON.stringify(wire));
      for (const f of files) body.append(f.field, f.data, f.filename);
    }
    const mutating =
      files !== undefined ||
      actions.some((a) => !nonMutating.has(a.method) && !["logIn", "logOut"].includes(a.method));
    let response: Response;
    try {
      response = await this.#fetch(`${this.baseUrl}/cgi/${files ? "upload" : "json-req"}`, {
        method: "POST",
        body,
        signal,
        redirect: "error",
      });
    } catch {
      throw new TransportError(mutating);
    }
    if (!response.ok) throw new TransportError(mutating, response.status);
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new TransportError(mutating);
    }
    if (signal.aborted) throw new TransportError(mutating);
    const reply = parseReply(text);
    if (reply.id !== undefined && reply.id !== id)
      throw new ProtocolError("response request id does not match");
    try {
      return checkReply(
        reply,
        wire.request.actions.map((a) => a.id),
      );
    } catch (error) {
      if (error instanceof XmoError && SESSION_ERRORS.has(error.code) && this.#session === session)
        this.#session = undefined;
      throw error;
    }
  }
}

/** Preserve callback multiplicity for wildcards: callers choose whether to flatten object wrappers. */
export function readCallbacks(reply: Reply): ReadResult[] {
  return reply.actions.flatMap((a) =>
    (a.callbacks ?? []).map((c: XmoCallback) => ({
      value: callbackValue(c),
      capability: c.parameters?.capability,
      xpath: c.xpath,
    })),
  );
}
