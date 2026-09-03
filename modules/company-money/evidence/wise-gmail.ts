import { type } from "arktype";

import {
  CalendarDateV1Schema,
  ISO_CURRENCY_MINOR_UNITS,
  IsoCurrencyV1Schema,
  parseMinorUnits,
  type IsoCurrency,
} from "../money.ts";
import type {
  IngestBatchV1,
  StableIdentity,
  TransactionCandidateV1,
} from "../ledger/ingest.ts";
import type { ClassificationV1, QuarantineEntryV1 } from "../ledger/state.ts";

export const MAX_WISE_ENVELOPE_BYTES = 1024 * 1024;
export const MAX_WISE_MESSAGE_BYTES = 64 * 1024;
export const MAX_WISE_MESSAGES = 100;
const PARSER_ID = "company-money/wise-gmail";

const BoundedSubjectV1Schema = type("string").narrow(
  (value, context) =>
    Buffer.byteLength(value, "utf8") <= 512 || context.mustBe("a bounded subject"),
);
const BoundedBodyV1Schema = type("string").narrow(
  (value, context) =>
    Buffer.byteLength(value, "utf8") <= MAX_WISE_MESSAGE_BYTES ||
    context.mustBe("a bounded message body"),
);
function isIsoUtcInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const canonical = value.includes(".") ? value : value.replace(/Z$/, ".000Z");
  return new Date(timestamp).toISOString() === canonical;
}

const IsoInstantV1Schema = type("string").narrow(
  (value, context) =>
    isIsoUtcInstant(value) || context.mustBe("a semantic ISO UTC instant"),
);
const WiseMessageV1Schema = type({
  "+": "reject",
  sourceRef: "string",
  receivedAt: IsoInstantV1Schema,
  subject: BoundedSubjectV1Schema,
  body: BoundedBodyV1Schema,
});

export const WiseGmailEnvelopeV1Schema = type({
  "+": "reject",
  kind: "'company-money.wise-gmail-envelope'",
  version: "1",
  accountAlias: "string",
  messages: WiseMessageV1Schema.array(),
}).narrow(
  (envelope, context) =>
    envelope.messages.length <= MAX_WISE_MESSAGES &&
      Buffer.byteLength(JSON.stringify(envelope), "utf8") <= MAX_WISE_ENVELOPE_BYTES ||
    context.mustBe("a bounded Wise Gmail envelope"),
);

export type WiseGmailEnvelopeV1 = typeof WiseGmailEnvelopeV1Schema.infer;

export const wiseGmailSchemaCatalog = {
  "company-money.wise-gmail-envelope": { 1: WiseGmailEnvelopeV1Schema },
} as const;

export interface WiseClassificationFacts {
  readonly accountAlias: string;
  readonly direction: TransactionCandidateV1["direction"];
  readonly counterpartyEntityId: string | null;
  readonly evidenceId: string;
}

export interface WiseGmailTranslatorOptions {
  readonly entityId: string;
  readonly accountAlias: string;
  readonly identity: StableIdentity;
  readonly classify: (
    facts: WiseClassificationFacts,
    suggested: "cashback" | null,
  ) => ClassificationV1;
}

type WiseFamily =
  | "received"
  | "pix-received"
  | "sent"
  | "cashback"
  | "cancelled"
  | "failed";

function family(subject: string): WiseFamily | null {
  const normalized = subject.normalize("NFKC").trim().toLowerCase();
  const families: Readonly<Record<string, WiseFamily>> = {
    "wise: received": "received",
    "wise: pix received": "pix-received",
    "wise: sent": "sent",
    "wise: cashback": "cashback",
    "wise: cancelled": "cancelled",
    "wise: failed": "failed",
  };
  return families[normalized] ?? null;
}

function bodyFields(body: string): ReadonlyMap<string, string> {
  const allowed = new Set([
    "transaction-id",
    "date",
    "amount",
    "currency",
    "counterparty",
    "reference",
  ]);
  const fields = new Map<string, string>();
  for (const line of body.split(/\r?\n/).filter((entry) => entry.trim().length > 0)) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new TypeError("malformed message");
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).normalize("NFKC").trim().replace(/\s+/g, " ");
    if (!allowed.has(key) || fields.has(key) || value.length === 0) {
      throw new TypeError("malformed message");
    }
    fields.set(key, value);
  }
  for (const required of ["date", "amount", "currency"]) {
    if (!fields.has(required)) throw new TypeError("malformed message");
  }
  return fields;
}

function quarantine(
  identity: StableIdentity,
  sourceRef: string,
  contentDigest: string,
  reason: QuarantineEntryV1["reason"],
): QuarantineEntryV1 {
  const evidenceId = identity.digest("company-money/evidence/wise/v1", [
    sourceRef,
    contentDigest,
  ]);
  return {
    kind: "company-money.quarantine-entry",
    version: 1,
    id: identity.digest("company-money/quarantine/v1", [evidenceId, reason]),
    provider: "wise",
    channel: "gmail-notification",
    sourceRef,
    evidenceId,
    contentDigest,
    parserId: PARSER_ID,
    parserVersion: 1,
    reason,
    resolution: "pending",
  };
}

function safeEnvelope(value: unknown, identity: StableIdentity): {
  readonly digest: string;
  readonly oversized: boolean;
} {
  try {
    const serialized = JSON.stringify(value);
    const messages =
      typeof value === "object" && value !== null && Array.isArray((value as { messages?: unknown }).messages)
        ? (value as { messages: unknown[] }).messages
        : [];
    const oversized =
      Buffer.byteLength(serialized, "utf8") > MAX_WISE_ENVELOPE_BYTES ||
      messages.length > MAX_WISE_MESSAGES ||
      messages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          typeof (message as { body?: unknown }).body === "string" &&
          Buffer.byteLength((message as { body: string }).body, "utf8") >
            MAX_WISE_MESSAGE_BYTES,
      );
    return {
      digest: identity.digest("company-money/wise-envelope/v1", [
        oversized ? "oversized" : serialized,
      ]),
      oversized,
    };
  } catch {
    return {
      digest: identity.digest("company-money/wise-envelope/v1", ["unserializable"]),
      oversized: false,
    };
  }
}

function selectedCurrency(value: string): IsoCurrency {
  const currency = value.toUpperCase();
  IsoCurrencyV1Schema.assert(currency);
  return currency as IsoCurrency;
}

function candidateFromMessage(
  message: WiseGmailEnvelopeV1["messages"][number],
  selectedFamily: WiseFamily,
  options: WiseGmailTranslatorOptions,
): TransactionCandidateV1 {
  const fields = bodyFields(message.body);
  const bookedOn = fields.get("date")!;
  CalendarDateV1Schema.assert(bookedOn);
  const currency = selectedCurrency(fields.get("currency")!);
  const contentDigest = options.identity.digest("company-money/wise-message-content/v1", [
    message.subject,
    message.body,
  ]);
  const evidenceId = options.identity.digest("company-money/evidence/wise/v1", [
    message.sourceRef,
    contentDigest,
  ]);
  const direction =
    selectedFamily === "received" ||
    selectedFamily === "pix-received" ||
    selectedFamily === "cashback"
      ? "incoming"
      : "outgoing";
  const status =
    selectedFamily === "cancelled"
      ? "cancelled"
      : selectedFamily === "failed"
        ? "failed"
        : "completed";
  const counterparty = fields.get("counterparty") ?? null;
  const reference = fields.get("reference") ?? null;
  return {
    kind: "company-money.transaction-candidate",
    version: 1,
    entityId: options.entityId,
    accountAlias: options.accountAlias,
    provider: "wise",
    occurredOn: bookedOn,
    bookedOn,
    money: {
      kind: "company-money.money",
      version: 1,
      currency,
      minorUnits: parseMinorUnits(fields.get("amount")!, currency),
    },
    direction,
    status,
    normalizedCounterparty: counterparty,
    normalizedReference: reference,
    providerTransactionId: fields.get("transaction-id") ?? null,
    sourcePosition: message.sourceRef,
    classification: options.classify(
      {
        accountAlias: options.accountAlias,
        direction,
        counterpartyEntityId: counterparty,
        evidenceId,
      },
      selectedFamily === "cashback" ? "cashback" : null,
    ),
    evidence: {
      kind: "company-money.evidence-ref",
      version: 1,
      id: evidenceId,
      provider: "wise",
      channel: "gmail-notification",
      sourceRef: message.sourceRef,
      contentDigest,
      grade: "secondary",
      parserId: PARSER_ID,
      parserVersion: 1,
    },
  };
}

export function translateWiseGmailEnvelope(
  value: unknown,
  options: WiseGmailTranslatorOptions,
): IngestBatchV1 {
  let envelope: WiseGmailEnvelopeV1;
  try {
    envelope = WiseGmailEnvelopeV1Schema.assert(value);
    if (
      envelope.accountAlias !== options.accountAlias ||
      envelope.accountAlias.length === 0 ||
      envelope.messages.some((message) => message.sourceRef.length === 0)
    ) {
      throw new TypeError("malformed envelope");
    }
  } catch {
    const sanitized = safeEnvelope(value, options.identity);
    return {
      kind: "company-money.ingest-batch",
      version: 1,
      candidates: [],
      quarantine: [
        quarantine(
          options.identity,
          sanitized.digest,
          sanitized.digest,
          sanitized.oversized ? "size-limit" : "malformed-envelope",
        ),
      ],
    };
  }

  const candidates: TransactionCandidateV1[] = [];
  const quarantined: QuarantineEntryV1[] = [];
  for (const message of envelope.messages) {
    const contentDigest = options.identity.digest("company-money/wise-message-content/v1", [
      message.subject,
      message.body,
    ]);
    const selectedFamily = family(message.subject);
    if (!selectedFamily) {
      quarantined.push(
        quarantine(
          options.identity,
          message.sourceRef,
          contentDigest,
          "unsupported-template",
        ),
      );
      continue;
    }
    try {
      candidates.push(candidateFromMessage(message, selectedFamily, options));
    } catch {
      const parsedCurrency = /(?:^|\n)currency:\s*([^\r\n]+)/i.exec(message.body)?.[1]
        ?.trim()
        .toUpperCase();
      quarantined.push(
        quarantine(
          options.identity,
          message.sourceRef,
          contentDigest,
          parsedCurrency && !Object.hasOwn(ISO_CURRENCY_MINOR_UNITS, parsedCurrency)
            ? "unsupported-currency"
            : "malformed-record",
        ),
      );
    }
  }
  return {
    kind: "company-money.ingest-batch",
    version: 1,
    candidates,
    quarantine: quarantined,
  };
}
