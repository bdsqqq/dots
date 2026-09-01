import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Revision {
  epoch: number;
  sequence: number;
}

interface CommandHeader {
  version: 1;
  fleet: string;
  to: string;
  resource: string;
  operation: "set";
  revision: Revision;
  notBefore: string | null;
  expiresAt: string | null;
}

interface EncryptedPayload {
  ephemeralPublicKey: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

export interface CommandEnvelope {
  kind: "command";
  id: string;
  header: CommandHeader;
  encryption: EncryptedPayload;
  authority: string;
  signature: string;
}

export type ReceiptStatus = "applied" | "rejected";

export interface ReceiptEnvelope {
  kind: "receipt";
  id: string;
  commandId: string;
  node: string;
  resource: string;
  revision: Revision;
  status: ReceiptStatus;
  reason: "stale" | "expired" | null;
  resultingRevision: Revision | null;
  recordedAt: string;
  signature: string;
}

export type MeshRecord = CommandEnvelope | ReceiptEnvelope;

export interface PublicIdentity {
  id: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
}

export interface NodeIdentity extends PublicIdentity {
  signingPrivateKey: string;
  encryptionPrivateKey: string;
}

interface ResourceState {
  revision: Revision;
  value: JsonValue;
  commandId: string;
}

interface CommandOutcome {
  receiptId: string;
  executions: number;
}

export interface MeshNodeSnapshot {
  version: 1;
  records: MeshRecord[];
  resources: Array<[string, ResourceState]>;
  outcomes: Array<[string, CommandOutcome]>;
}

export interface ReconcileResult {
  rounds: number;
  recordsSent: number;
}

function keyToPem(key: KeyObject, type: "pkcs8" | "spki"): string {
  return key.export({ format: "pem", type }).toString();
}

export function createNodeIdentity(id: string): NodeIdentity {
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("x25519");
  return {
    id,
    signingPrivateKey: keyToPem(signing.privateKey, "pkcs8"),
    signingPublicKey: keyToPem(signing.publicKey, "spki"),
    encryptionPrivateKey: keyToPem(encryption.privateKey, "pkcs8"),
    encryptionPublicKey: keyToPem(encryption.publicKey, "spki"),
  };
}

export function publicIdentity(identity: NodeIdentity): PublicIdentity {
  return {
    id: identity.id,
    signingPublicKey: identity.signingPublicKey,
    encryptionPublicKey: identity.encryptionPublicKey,
  };
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new Error("signed numbers must be safe integers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function serializable(value: unknown): JsonValue {
  return value as JsonValue;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(serializable(value))).digest("hex");
}

function signatureFor(value: unknown, privateKey: string): string {
  return sign(
    null,
    Buffer.from(canonicalJson(serializable(value))),
    createPrivateKey(privateKey),
  ).toString("base64");
}

function validSignature(value: unknown, signature: string, publicKey: string): boolean {
  return verify(
    null,
    Buffer.from(canonicalJson(serializable(value))),
    createPublicKey(publicKey),
    Buffer.from(signature, "base64"),
  );
}

function commandSignedFields(command: Omit<CommandEnvelope, "id" | "signature">): JsonValue {
  return serializable(command);
}

function commandId(command: Omit<CommandEnvelope, "id">): string {
  return hash(command);
}

function receiptSignedFields(receipt: Omit<ReceiptEnvelope, "id" | "signature">): JsonValue {
  return serializable(receipt);
}

function receiptId(receipt: Omit<ReceiptEnvelope, "id">): string {
  return hash(receipt);
}

function encryptionKey(sharedSecret: Buffer, header: CommandHeader): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      sharedSecret,
      Buffer.from("fleet-mesh-v1"),
      Buffer.from(canonicalJson(serializable(header))),
      32,
    ),
  );
}

function encryptPayload(
  value: JsonValue,
  recipientPublicKey: string,
  header: CommandHeader,
): EncryptedPayload {
  const ephemeral = generateKeyPairSync("x25519");
  const sharedSecret = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: createPublicKey(recipientPublicKey),
  });
  const key = encryptionKey(sharedSecret, header);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(canonicalJson(serializable(header))));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(canonicalJson(value))),
    cipher.final(),
  ]);
  return {
    ephemeralPublicKey: keyToPem(ephemeral.publicKey, "spki"),
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptCommand(command: CommandEnvelope, identity: NodeIdentity): JsonValue {
  if (command.header.to !== identity.id) {
    throw new Error(`command is addressed to ${command.header.to}, not ${identity.id}`);
  }
  const sharedSecret = diffieHellman({
    privateKey: createPrivateKey(identity.encryptionPrivateKey),
    publicKey: createPublicKey(command.encryption.ephemeralPublicKey),
  });
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(sharedSecret, command.header),
    Buffer.from(command.encryption.iv, "base64"),
  );
  decipher.setAAD(Buffer.from(canonicalJson(serializable(command.header))));
  decipher.setAuthTag(Buffer.from(command.encryption.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(command.encryption.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as JsonValue;
}

export class FleetAuthority {
  readonly id: string;
  readonly publicKey: string;
  readonly #privateKey: string;

  constructor(id = "fleet-admin") {
    const keys = generateKeyPairSync("ed25519");
    this.id = id;
    this.#privateKey = keyToPem(keys.privateKey, "pkcs8");
    this.publicKey = keyToPem(keys.publicKey, "spki");
  }

  issueSet(options: {
    fleet: string;
    recipient: PublicIdentity;
    resource: string;
    revision: Revision;
    value: JsonValue;
    notBefore?: Date;
    expiresAt?: Date;
  }): CommandEnvelope {
    const header: CommandHeader = {
      version: 1,
      fleet: options.fleet,
      to: options.recipient.id,
      resource: options.resource,
      operation: "set",
      revision: options.revision,
      notBefore: options.notBefore?.toISOString() ?? null,
      expiresAt: options.expiresAt?.toISOString() ?? null,
    };
    const unsigned = {
      kind: "command" as const,
      header,
      encryption: encryptPayload(options.value, options.recipient.encryptionPublicKey, header),
      authority: this.id,
    };
    const signature = signatureFor(commandSignedFields(unsigned), this.#privateKey);
    const withSignature = { ...unsigned, signature };
    return { ...withSignature, id: commandId(withSignature) };
  }
}

function compareRevision(left: Revision, right: Revision): number {
  return left.epoch === right.epoch
    ? left.sequence - right.sequence
    : left.epoch - right.epoch;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class MeshNode {
  readonly identity: NodeIdentity;
  readonly #fleet: string;
  readonly #authorityId: string;
  readonly #authorityPublicKey: string;
  readonly #roster: Map<string, PublicIdentity>;
  readonly #clock: () => Date;
  readonly #records = new Map<string, MeshRecord>();
  readonly #resources = new Map<string, ResourceState>();
  readonly #outcomes = new Map<string, CommandOutcome>();

  constructor(options: {
    identity: NodeIdentity;
    fleet: string;
    authority: { id: string; publicKey: string };
    roster: PublicIdentity[];
    clock?: () => Date;
    snapshot?: MeshNodeSnapshot;
  }) {
    this.identity = options.identity;
    this.#fleet = options.fleet;
    this.#authorityId = options.authority.id;
    this.#authorityPublicKey = options.authority.publicKey;
    this.#roster = new Map(options.roster.map((identity) => [identity.id, identity]));
    this.#clock = options.clock ?? (() => new Date());
    if (options.snapshot) {
      for (const record of options.snapshot.records) this.#records.set(record.id, copy(record));
      for (const [resource, state] of options.snapshot.resources) {
        this.#resources.set(resource, copy(state));
      }
      for (const [command, outcome] of options.snapshot.outcomes) {
        this.#outcomes.set(command, copy(outcome));
      }
    }
  }

  get id(): string {
    return this.identity.id;
  }

  records(): MeshRecord[] {
    return [...this.#records.values()].map(copy);
  }

  snapshot(): MeshNodeSnapshot {
    return {
      version: 1,
      records: this.records(),
      resources: [...this.#resources.entries()].map(copy),
      outcomes: [...this.#outcomes.entries()].map(copy),
    };
  }

  ingest(records: MeshRecord[]): number {
    let accepted = 0;
    const commandsFirst = [...records].sort((left, right) =>
      left.kind === right.kind ? 0 : left.kind === "command" ? -1 : 1,
    );
    for (const record of commandsFirst) {
      if (this.#records.has(record.id) || !this.#validRecord(record)) continue;
      this.#records.set(record.id, copy(record));
      accepted += 1;
    }
    this.processPending();
    return accepted;
  }

  processPending(): void {
    const pending = [...this.#records.values()]
      .filter(
        (record): record is CommandEnvelope =>
          record.kind === "command" &&
          record.header.to === this.id &&
          !this.#outcomes.has(record.id),
      )
      .sort((left, right) => compareRevision(right.header.revision, left.header.revision));
    for (const command of pending) this.#process(command);
  }

  readResource(resource: string): ResourceState | null {
    const state = this.#resources.get(resource);
    return state ? copy(state) : null;
  }

  receiptFor(commandId: string): ReceiptEnvelope | null {
    const receipt = [...this.#records.values()].find(
      (record): record is ReceiptEnvelope =>
        record.kind === "receipt" &&
        record.commandId === commandId &&
        this.#validRecord(record),
    );
    return receipt ? copy(receipt) : null;
  }

  executionCount(commandId: string): number {
    return this.#outcomes.get(commandId)?.executions ?? 0;
  }

  #validRecord(record: MeshRecord): boolean {
    if (record.kind === "command") {
      if (
        record.header.version !== 1 ||
        record.header.fleet !== this.#fleet ||
        record.authority !== this.#authorityId
      ) {
        return false;
      }
      const { id, signature, ...unsigned } = record;
      return (
        id === commandId({ ...unsigned, signature }) &&
        validSignature(commandSignedFields(unsigned), signature, this.#authorityPublicKey)
      );
    }
    const signer = this.#roster.get(record.node);
    const command = this.#records.get(record.commandId);
    if (
      !signer ||
      command?.kind !== "command" ||
      record.node !== command.header.to ||
      record.resource !== command.header.resource ||
      compareRevision(record.revision, command.header.revision) !== 0
    ) {
      return false;
    }
    const { id, signature, ...unsigned } = record;
    return (
      id === receiptId({ ...unsigned, signature }) &&
      validSignature(receiptSignedFields(unsigned), signature, signer.signingPublicKey)
    );
  }

  #process(command: CommandEnvelope): void {
    const now = this.#clock();
    if (command.header.notBefore && now < new Date(command.header.notBefore)) return;
    if (command.header.expiresAt && now >= new Date(command.header.expiresAt)) {
      this.#recordOutcome(command, "rejected", "expired", null, 0);
      return;
    }
    const current = this.#resources.get(command.header.resource);
    if (current && compareRevision(command.header.revision, current.revision) <= 0) {
      this.#recordOutcome(command, "rejected", "stale", current.revision, 0);
      return;
    }
    const value = decryptCommand(command, this.identity);
    this.#resources.set(command.header.resource, {
      revision: copy(command.header.revision),
      value,
      commandId: command.id,
    });
    this.#recordOutcome(command, "applied", null, command.header.revision, 1);
  }

  #recordOutcome(
    command: CommandEnvelope,
    status: ReceiptStatus,
    reason: ReceiptEnvelope["reason"],
    resultingRevision: Revision | null,
    executions: number,
  ): void {
    const unsigned = {
      kind: "receipt" as const,
      commandId: command.id,
      node: this.id,
      resource: command.header.resource,
      revision: copy(command.header.revision),
      status,
      reason,
      resultingRevision: resultingRevision ? copy(resultingRevision) : null,
      recordedAt: this.#clock().toISOString(),
    };
    const signature = signatureFor(receiptSignedFields(unsigned), this.identity.signingPrivateKey);
    const withSignature = { ...unsigned, signature };
    const receipt: ReceiptEnvelope = { ...withSignature, id: receiptId(withSignature) };
    this.#records.set(receipt.id, receipt);
    this.#outcomes.set(command.id, { receiptId: receipt.id, executions });
  }
}

export function reconcile(left: MeshNode, right: MeshNode): ReconcileResult {
  let recordsSent = 0;
  let rounds = 0;
  for (; rounds < 16; rounds += 1) {
    const leftIds = new Set(left.records().map((record) => record.id));
    const rightIds = new Set(right.records().map((record) => record.id));
    const toLeft = right.records().filter((record) => !leftIds.has(record.id));
    const toRight = left.records().filter((record) => !rightIds.has(record.id));
    if (toLeft.length === 0 && toRight.length === 0) break;
    recordsSent += toLeft.length + toRight.length;
    left.ingest(toLeft);
    right.ingest(toRight);
  }
  if (rounds === 16) throw new Error("reconciliation did not converge");
  return { rounds, recordsSent };
}
