import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { createRouterClient, implement } from "@orpc/server";
import { type } from "arktype";
import { lock } from "proper-lockfile";

import {
  FleetAuthority,
  validV1CommandRecord,
  validV1ReceiptRecord,
  type CommandEnvelope,
} from "../fleet-mesh.ts";
import {
  MeshRecordV1Schema,
  PublicIdentityV1Schema,
  RevisionV1Schema,
  type MeshRecord,
  type PublicIdentity,
  type ReceiptEnvelope,
  type Revision,
} from "../fleet-protocol.ts";
import {
  desiredStateContract,
  getDesiredStateStatus,
  setDesiredState,
  type DesiredStateController,
  type DesiredStateSetInputV1,
  type DesiredStateStatusV1,
  type DesiredStateSubmissionV1,
} from "./public.ts";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

const GossipResponseV1Schema = type({
  "+": "reject",
  accepted: "number.safe & number.integer",
  records: MeshRecordV1Schema.array(),
});

export const DesiredStateRevisionStateV1Schema = type({
  "+": "reject",
  kind: "'fleet.desired-state-revision-state'",
  version: "1",
  revision: RevisionV1Schema,
});
export type DesiredStateRevisionStateV1 =
  typeof DesiredStateRevisionStateV1Schema.infer;

type Fetch = typeof globalThis.fetch;
type GossipResponseV1 = typeof GossipResponseV1Schema.infer;

export interface FileDesiredStateControllerOptions {
  fleet: string;
  authority: {
    id: string;
    publicKey: string;
  };
  authorityPrivateKey: string;
  recipients: readonly PublicIdentity[];
  bridgeOrigin: string;
  revisionStatePath: string;
  fetch?: Fetch;
  clock?: () => Date;
}

function compareRevision(left: Revision, right: Revision): number {
  if (left.epoch !== right.epoch) return left.epoch < right.epoch ? -1 : 1;
  if (left.sequence !== right.sequence) {
    return left.sequence < right.sequence ? -1 : 1;
  }
  return 0;
}

function maximumRevision(revisions: readonly Revision[]): Revision | undefined {
  let maximum: Revision | undefined;
  for (const revision of revisions) {
    if (!maximum || compareRevision(revision, maximum) > 0) maximum = revision;
  }
  return maximum ? { ...maximum } : undefined;
}

function nextRevision(previous: Revision | undefined, now: Date): Revision {
  const epoch = now.getTime();
  if (!Number.isSafeInteger(epoch)) throw new Error("clock must return a valid Date");
  if (!previous || epoch > previous.epoch) return { epoch, sequence: 0 };
  if (previous.sequence < Number.MAX_SAFE_INTEGER) {
    return { epoch: previous.epoch, sequence: previous.sequence + 1 };
  }
  if (previous.epoch >= Number.MAX_SAFE_INTEGER) {
    throw new Error("revision space is exhausted");
  }
  return { epoch: previous.epoch + 1, sequence: 0 };
}

function parseBridgeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("bridgeOrigin must be an HTTP(S) origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("bridgeOrigin must be an HTTP(S) origin");
  }
  return url.origin;
}

function dateFromInput(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("date input is invalid");
  return date;
}

async function readLimitedBody(
  source: AsyncIterable<Uint8Array>,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of source) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_RESPONSE_BYTES) {
      throw new Error("bridge gossip response exceeds 1 MiB");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readRevisionState(
  path: string,
): Promise<DesiredStateRevisionStateV1 | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    const state = DesiredStateRevisionStateV1Schema.assert(value);
    if (state !== value) {
      throw new TypeError("revision state validation must preserve object identity");
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeRevisionState(
  path: string,
  state: DesiredStateRevisionStateV1,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  let closed = false;
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    closed = true;
    await rename(temporary, path);
    await chmod(path, 0o600);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

interface AuthenticatedGossipResponse extends GossipResponseV1 {
  recordsById: ReadonlyMap<string, MeshRecord>;
}

export class FileDesiredStateController implements DesiredStateController {
  readonly #fleet: string;
  readonly #authority: FleetAuthority;
  readonly #authorityPublic: { id: string; publicKey: string };
  readonly #recipients: ReadonlyMap<string, PublicIdentity>;
  readonly #bridgeOrigin: string;
  readonly #revisionStatePath: string;
  readonly #fetch: Fetch;
  readonly #clock: () => Date;

  constructor(options: FileDesiredStateControllerOptions) {
    this.#fleet = options.fleet;
    this.#authority = new FleetAuthority(
      options.authority.id,
      options.authorityPrivateKey,
    );
    if (this.#authority.publicKey !== options.authority.publicKey) {
      throw new Error("authority public key does not match private key");
    }
    this.#authorityPublic = { ...options.authority };

    const recipients = new Map<string, PublicIdentity>();
    for (const identity of options.recipients) {
      const validated = PublicIdentityV1Schema.assert(identity);
      if (validated !== identity) {
        throw new TypeError("recipient validation must preserve object identity");
      }
      if (recipients.has(validated.id)) {
        throw new Error(`duplicate recipient id: ${validated.id}`);
      }
      recipients.set(validated.id, { ...validated });
    }
    this.#recipients = recipients;
    this.#bridgeOrigin = parseBridgeOrigin(options.bridgeOrigin);
    this.#revisionStatePath = options.revisionStatePath;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#clock = options.clock ?? (() => new Date());
  }

  async set(
    input: DesiredStateSetInputV1,
  ): Promise<DesiredStateSubmissionV1 | undefined> {
    const recipient = this.#recipients.get(input.nodeId);
    if (!recipient) return undefined;

    const revision = await this.#allocateRevision(input.nodeId, input.resource);
    const command = this.#authority.issueSet({
      fleet: this.#fleet,
      recipient,
      resource: input.resource,
      revision,
      value: input.value,
      notBefore: dateFromInput(input.notBefore),
      expiresAt: dateFromInput(input.expiresAt),
    });
    const response = await this.#gossip([command]);
    const returned = response.recordsById.get(command.id);
    if (returned?.kind !== "command" || !isDeepStrictEqual(returned, command)) {
      throw new Error("bridge did not acknowledge the submitted command exactly");
    }
    return {
      kind: "fleet.desired-state-submission",
      version: 1,
      commandId: command.id,
      revision: { ...revision },
    };
  }

  async status(commandId: string): Promise<DesiredStateStatusV1 | undefined> {
    const response = await this.#gossip([]);
    const record = response.recordsById.get(commandId);
    if (
      record?.kind !== "command" ||
      record.authority !== this.#authority.id ||
      record.header.fleet !== this.#fleet ||
      !this.#recipients.has(record.header.to)
    ) {
      return undefined;
    }

    const receipt = response.records.find(
      (candidate): candidate is ReceiptEnvelope =>
        candidate.kind === "receipt" &&
        candidate.commandId === record.id &&
        candidate.node === record.header.to &&
        candidate.resource === record.header.resource &&
        compareRevision(candidate.revision, record.header.revision) === 0,
    );
    if (!receipt) {
      return {
        kind: "fleet.desired-state-status",
        version: 1,
        commandId,
        state: "pending",
        receipt: null,
      };
    }
    return {
      kind: "fleet.desired-state-status",
      version: 1,
      commandId,
      state: "recorded",
      receipt: structuredClone(receipt),
    };
  }

  async #allocateRevision(nodeId: string, resource: string): Promise<Revision> {
    await mkdir(dirname(this.#revisionStatePath), {
      recursive: true,
      mode: 0o700,
    });
    const release = await lock(this.#revisionStatePath, {
      realpath: false,
      stale: 10_000,
      update: 2_000,
      retries: {
        retries: 100,
        factor: 1,
        minTimeout: 20,
        maxTimeout: 20,
        randomize: false,
      },
    });
    try {
      const [state, response] = await Promise.all([
        readRevisionState(this.#revisionStatePath),
        this.#gossip([]),
      ]);
      const returned = response.records
        .filter(
          (record): record is CommandEnvelope =>
            record.kind === "command" &&
            record.authority === this.#authority.id &&
            record.header.fleet === this.#fleet &&
            record.header.to === nodeId &&
            record.header.resource === resource,
        )
        .map((command) => command.header.revision);
      const previous = maximumRevision([
        ...(state ? [state.revision] : []),
        ...returned,
      ]);
      const revision = nextRevision(previous, this.#clock());
      await writeRevisionState(this.#revisionStatePath, {
        kind: "fleet.desired-state-revision-state",
        version: 1,
        revision,
      });
      return revision;
    } finally {
      await release();
    }
  }

  async #gossip(
    records: readonly MeshRecord[],
  ): Promise<AuthenticatedGossipResponse> {
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("bridge gossip request timed out"));
      }, REQUEST_TIMEOUT_MS);
    });
    try {
      const response = await Promise.race([
        this.#gossipRequest(records, controller.signal),
        timedOut,
      ]);
      return this.#authenticateResponse(response);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async #gossipRequest(
    records: readonly MeshRecord[],
    signal: AbortSignal,
  ): Promise<GossipResponseV1> {
    const response = await this.#fetch(new URL("/gossip", this.#bridgeOrigin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(records),
      signal,
    });
    if (!response.ok) throw new Error(`bridge returned HTTP ${response.status}`);
    if (!response.body) throw new Error("bridge returned an empty gossip response");
    const value: unknown = JSON.parse(
      (await readLimitedBody(response.body)).toString("utf8"),
    );
    const result = GossipResponseV1Schema.assert(value);
    if (result !== value) {
      throw new TypeError("gossip response validation must preserve object identity");
    }
    if (result.accepted < 0) {
      throw new TypeError("bridge accepted count cannot be negative");
    }
    return result;
  }

  #authenticateResponse(response: GossipResponseV1): AuthenticatedGossipResponse {
    const recordsById = new Map<string, MeshRecord>();
    for (const record of response.records) {
      if (recordsById.has(record.id)) {
        throw new Error(`bridge returned duplicate record id: ${record.id}`);
      }
      recordsById.set(record.id, record);
    }

    for (const record of response.records) {
      if (record.kind === "command") {
        if (!validV1CommandRecord(record, this.#fleet, this.#authorityPublic)) {
          throw new Error(`bridge returned invalid command record: ${record.id}`);
        }
        continue;
      }
      const command = recordsById.get(record.commandId);
      const signer = this.#recipients.get(record.node);
      if (
        command?.kind !== "command" ||
        !signer ||
        !validV1ReceiptRecord(record, command, signer)
      ) {
        throw new Error(`bridge returned invalid receipt record: ${record.id}`);
      }
    }
    return { ...response, recordsById };
  }
}

export function createDesiredStateRouter(controller: DesiredStateController) {
  const os = implement(desiredStateContract);
  return os.router({
    set: os.set.handler(async ({ input, errors }) => {
      const submission = await setDesiredState(controller, input);
      if (!submission) {
        throw errors.NODE_NOT_FOUND({
          data: {
            kind: "fleet.node-not-found",
            version: 1,
            id: input.nodeId,
          },
        });
      }
      return submission;
    }),
    status: os.status.handler(async ({ input, errors }) => {
      const status = await getDesiredStateStatus(controller, input);
      if (!status) {
        throw errors.COMMAND_NOT_FOUND({
          data: {
            kind: "fleet.command-not-found",
            version: 1,
            commandId: input,
          },
        });
      }
      return status;
    }),
  });
}

export function createDesiredStateClient(controller: DesiredStateController) {
  return createRouterClient(createDesiredStateRouter(controller));
}
