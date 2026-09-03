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

import { type } from "arktype";

import {
  validateV1JsonValue,
  validateV1Revision,
  type CommandEnvelope,
  type JsonValue,
  type MeshNodeSnapshot,
  type MeshRecord,
  type PublicIdentity,
  type ReceiptEnvelope,
  type Revision,
} from "./fleet-protocol.ts";

export type {
  CommandEnvelope,
  JsonValue,
  MeshNodeSnapshot,
  MeshRecord,
  PublicIdentity,
  ReceiptEnvelope,
  Revision,
} from "./fleet-protocol.ts";

type CommandHeader = CommandEnvelope["header"];
type EncryptedPayload = CommandEnvelope["encryption"];
export type ReceiptStatus = ReceiptEnvelope["status"];

export const NodeIdentityV1Schema = type({
  "+": "reject",
  id: "string",
  signingPublicKey: "string",
  encryptionPublicKey: "string",
  signingPrivateKey: "string",
  encryptionPrivateKey: "string",
});
export type NodeIdentity = typeof NodeIdentityV1Schema.infer;

type ResourceState = MeshNodeSnapshot["resources"][number][1];
type CommandOutcome = MeshNodeSnapshot["outcomes"][number][1];

class InvalidCommandError extends Error {
  constructor(commandId: string, cause: unknown) {
    super(`command ${commandId} cannot be decrypted or decoded`, { cause });
  }
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

function canonicalPrivateKey(pem: string, algorithm: "ed25519" | "x25519", label: string) {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== algorithm || keyToPem(key, "pkcs8") !== pem) {
    throw new Error(`${label} must be a canonical ${algorithm} PKCS#8 private key`);
  }
  return key;
}

function canonicalPublicKey(pem: string, algorithm: "ed25519" | "x25519", label: string) {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== algorithm || keyToPem(key, "spki") !== pem) {
    throw new Error(`${label} must be a canonical ${algorithm} SPKI public key`);
  }
  return key;
}

export function validateNodeIdentityKeys(identity: NodeIdentity): void {
  const signingPrivate = canonicalPrivateKey(
    identity.signingPrivateKey,
    "ed25519",
    "signingPrivateKey",
  );
  canonicalPublicKey(identity.signingPublicKey, "ed25519", "signingPublicKey");
  if (keyToPem(createPublicKey(signingPrivate), "spki") !== identity.signingPublicKey) {
    throw new Error("signing public key does not match signing private key");
  }

  const encryptionPrivate = canonicalPrivateKey(
    identity.encryptionPrivateKey,
    "x25519",
    "encryptionPrivateKey",
  );
  canonicalPublicKey(identity.encryptionPublicKey, "x25519", "encryptionPublicKey");
  if (
    keyToPem(createPublicKey(encryptionPrivate), "spki") !==
    identity.encryptionPublicKey
  ) {
    throw new Error("encryption public key does not match encryption private key");
  }
}

export function validateAuthorityPublicKey(publicKey: string): void {
  canonicalPublicKey(publicKey, "ed25519", "authority publicKey");
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
  const value: unknown = JSON.parse(plaintext.toString("utf8"));
  validateV1JsonValue(value);
  return value;
}

export class FleetAuthority {
  readonly id: string;
  readonly publicKey: string;
  readonly #privateKey: string;

  constructor(id = "fleet-admin", privateKey?: string) {
    this.id = id;
    if (privateKey === undefined) {
      const keys = generateKeyPairSync("ed25519");
      this.#privateKey = keyToPem(keys.privateKey, "pkcs8");
      this.publicKey = keyToPem(keys.publicKey, "spki");
    } else {
      const key = canonicalPrivateKey(privateKey, "ed25519", "authority privateKey");
      this.#privateKey = privateKey;
      this.publicKey = keyToPem(createPublicKey(key), "spki");
    }
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
    validateV1Revision(options.revision);
    validateV1JsonValue(options.value);
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
  readonly #suppressedCommands = new Set<string>();

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

  ingest(records: readonly MeshRecord[]): number {
    const acceptedIds: string[] = [];
    const commandsFirst = [...records].sort((left, right) =>
      left.kind === right.kind ? 0 : left.kind === "command" ? -1 : 1,
    );
    for (const record of commandsFirst) {
      if (this.#records.has(record.id) || !this.#validRecord(record)) continue;
      this.#records.set(record.id, copy(record));
      acceptedIds.push(record.id);
    }
    this.processPending();
    return acceptedIds.filter((id) => this.#records.has(id)).length;
  }

  processPending(): void {
    const pending = [...this.#records.values()]
      .filter(
        (record): record is CommandEnvelope =>
          record.kind === "command" &&
          record.header.to === this.id &&
          !this.#outcomes.has(record.id) &&
          !this.#suppressedCommands.has(record.id),
      )
      .sort((left, right) => compareRevision(right.header.revision, left.header.revision));
    for (const command of pending) {
      try {
        this.#processAtomically(command);
      } catch (error) {
        if (error instanceof InvalidCommandError) {
          this.#suppressedCommands.add(command.id);
          continue;
        }
        throw error;
      }
    }
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
    let value: JsonValue;
    try {
      value = decryptCommand(command, this.identity);
    } catch (error) {
      throw new InvalidCommandError(command.id, error);
    }
    this.#resources.set(command.header.resource, {
      revision: copy(command.header.revision),
      value,
      commandId: command.id,
    });
    this.#recordOutcome(command, "applied", null, command.header.revision, 1);
  }

  #processAtomically(command: CommandEnvelope): void {
    const records = new Map(this.#records);
    const resources = new Map(this.#resources);
    const outcomes = new Map(this.#outcomes);
    try {
      this.#process(command);
    } catch (error) {
      this.#records.clear();
      for (const entry of records) this.#records.set(...entry);
      this.#resources.clear();
      for (const entry of resources) this.#resources.set(...entry);
      this.#outcomes.clear();
      for (const entry of outcomes) this.#outcomes.set(...entry);
      throw error;
    }
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
