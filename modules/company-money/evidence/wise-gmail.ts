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
  | "failed"
  | "returned";

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
  if (families[normalized]) return families[normalized];
  if (/^transfer sent \(#\d+\)$/.test(normalized)) return "sent";
  if (/^transfer cancelled \(#\d+\)$/.test(normalized)) return "cancelled";
  if (/^there[’']s a problem with your transfer \(#\d+\)$/.test(normalized)) return "returned";
  if (/^money received from .+$/.test(normalized)) return "received";
  if (/^pix of [\d,.]+ [a-z]{3} received$/.test(normalized)) return "pix-received";
  if (/^your business received cashback for [a-z]+$/.test(normalized)) return "cashback";
  return null;
}

function nativeFields(message: WiseGmailEnvelopeV1["messages"][number], selected: WiseFamily, entityId: string): ReadonlyMap<string, string> {
  const lines = message.body.normalize("NFKC").split(/\r?\n/).map(line => line.trim().replace(/\s+/g, " ")).filter(Boolean);
  const body = lines.join(" ");
  const accountMarker = `for the business account of ${entityId.normalize("NFKC").toLowerCase().replace(/\.$/, "")}.`;
  if (!body.toLowerCase().includes(`${accountMarker} `) && !body.toLowerCase().endsWith(accountMarker)) throw new TypeError("account ownership unresolved");
  const field = (name: string) => {
    const indexes = lines.flatMap((line, i) => line.toLowerCase() === `${name.toLowerCase()}:` ? [i] : []);
    if (indexes.length !== 1 || !lines[indexes[0] + 1]) throw new TypeError("missing or ambiguous field");
    return lines[indexes[0] + 1];
  };
  const money = (value: string) => {
    const match = /^(\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?) ([A-Z]{3})$/.exec(value);
    if (!match) throw new TypeError("malformed amount");
    const amount = match[1].replace(/,/g, "");
    const currency = selectedCurrency(match[2]);
    return { amount, currency, units: parseMinorUnits(amount, currency) };
  };
  const agrees = (narrative: string, expected: ReturnType<typeof money>) => {
    const actual = money(narrative);
    return actual.currency === expected.currency && actual.units === expected.units;
  };
  const fields = new Map<string, string>();
  let amount: ReturnType<typeof money>;
  if (selected === "received" || selected === "pix-received") {
    amount = money(field("Amount received"));
    const confirmation = /You received (?:a Pix of )?([\d,.]+ [A-Z]{3}) from /.exec(body);
    if (!confirmation || !agrees(confirmation[1], amount)) throw new TypeError("receipt not confirmed");
    fields.set("counterparty", field("From"));
    fields.set("reference", field("Reference"));
    fields.set("transaction-id", field("Transfer number").replace(/^#/, ""));
  } else if (selected === "sent") {
    amount = money(field("Amount"));
    const confirmation = /([\d,.]+ [A-Z]{3}) is now in (.+?)[’']s account\./.exec(body);
    if (!confirmation || !agrees(confirmation[1], amount)) throw new TypeError("delivery not confirmed");
    if (!new RegExp(`^0(?:\\.0+)? ${amount.currency}$`).test(field("Wise fee"))) throw new TypeError("nonzero fee requires statement evidence");
    fields.set("counterparty", confirmation[2]);
    fields.set("transaction-id", field("Transfer number").replace(/^#/, ""));
  } else if (selected === "cancelled" || selected === "returned") {
    const confirmation = selected === "cancelled"
      ? /We[’']ve cancelled your transfer of ([\d,.]+ [A-Z]{3})\./.exec(body)
      : /Your transfer of ([\d,.]+ [A-Z]{3}) to .+? was sent back to us\./.exec(body);
    if (!confirmation) throw new TypeError("transfer state unconfirmed");
    amount = money(confirmation[1]);
    fields.set("transaction-id", /\(#(\d+)\)$/.exec(message.subject)?.[1] ?? "");
  } else if (selected === "cashback") {
    const matches = [...body.matchAll(/You[’']ve received ([\d,.]+ [A-Z]{3}) cashback for ([A-Za-z]+)\./g)];
    if (matches.length !== 1 || !message.subject.toLowerCase().endsWith(` for ${matches[0][2].toLowerCase()}`)) throw new TypeError("cashback unconfirmed");
    amount = money(matches[0][1]);
    const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const month = months.indexOf(matches[0][2].toLowerCase()) + 1;
    if (!month) throw new TypeError("unknown cashback period");
    const received = new Date(message.receivedAt);
    const year = received.getUTCFullYear() - (month > received.getUTCMonth() + 1 ? 1 : 0);
    fields.set("transaction-id", `cashback-period:${year}-${String(month).padStart(2, "0")}`);
    fields.set("reference", `cashback for ${year}-${String(month).padStart(2, "0")}`);
  } else throw new TypeError("unsupported native family");
  const subjectId = /\(#(\d+)\)$/.exec(message.subject)?.[1];
  const id = fields.get("transaction-id");
  if (!id || (selected !== "cashback" && !/^\d+$/.test(id)) || (subjectId && subjectId !== id)) throw new TypeError("transfer identity mismatch");
  fields.set("amount", amount.amount);
  fields.set("currency", amount.currency);
  fields.set("date", message.receivedAt.slice(0, 10));
  return fields;
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
  const native = !/^wise:/i.test(message.subject.normalize("NFKC").trim());
  const fields = native ? nativeFields(message, selectedFamily, options.entityId) : bodyFields(message.body);
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
        : selectedFamily === "returned"
          ? "pending"
        : "completed";
  const counterparty = fields.get("counterparty") ?? null;
  const reference = fields.get("reference") ?? null;
  return {
    kind: "company-money.transaction-candidate",
    version: 1,
    entityId: options.entityId,
    accountAlias: options.accountAlias,
    provider: "wise",
    occurredOn: native ? null : bookedOn,
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
      parserId: native ? `${PARSER_ID}/native-notification` : PARSER_ID,
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
