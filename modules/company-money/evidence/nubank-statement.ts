import { type } from "arktype";

import {
  CalendarDateV1Schema,
  ISO_CURRENCY_MINOR_UNITS,
  IsoCurrencyV1Schema,
  compareCodeUnits,
  parseMinorUnits,
  type IsoCurrency,
} from "../money.ts";
import type {
  IngestBatchV1,
  StableIdentity,
  TransactionCandidateV1,
} from "../ledger/ingest.ts";
import type { ClassificationV1, QuarantineEntryV1 } from "../ledger/state.ts";

export const MAX_NUBANK_STATEMENT_BYTES = 4 * 1024 * 1024;
export const MAX_NUBANK_STATEMENT_ROWS = 10_000;
const PARSER_ID = "company-money/nubank-statement";

const BoundedCsvV1Schema = type("string").narrow(
  (value, context) =>
    Buffer.byteLength(value, "utf8") <= MAX_NUBANK_STATEMENT_BYTES ||
    context.mustBe("a bounded statement"),
);

export const NubankStatementEnvelopeV1Schema = type({
  "+": "reject",
  kind: "'company-money.nubank-statement-envelope'",
  version: "1",
  accountAlias: "string",
  sourceRef: "string",
  csv: BoundedCsvV1Schema,
});

export type NubankStatementEnvelopeV1 = typeof NubankStatementEnvelopeV1Schema.infer;

export const nubankStatementSchemaCatalog = {
  "company-money.nubank-statement-envelope": { 1: NubankStatementEnvelopeV1Schema },
} as const;

export interface NubankClassificationFacts {
  readonly accountAlias: string;
  readonly direction: TransactionCandidateV1["direction"];
  readonly counterpartyEntityId: string | null;
  readonly evidenceId: string;
}

export interface NubankStatementTranslatorOptions {
  readonly entityId: string;
  readonly accountAlias: string;
  readonly identity: StableIdentity;
  readonly classify: (facts: NubankClassificationFacts) => ClassificationV1;
}

const expectedHeader = [
  "date",
  "amount",
  "currency",
  "direction",
  "status",
  "transaction_id",
  "counterparty",
  "reference",
] as const;

function normalizeText(value: string): string | null {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  return normalized.length === 0 ? null : normalized;
}

function parseRow(line: string, delimiter: "," | ";"): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new TypeError("malformed record");
  fields.push(field);
  return fields;
}

function delimiterFor(header: string): "," | ";" {
  const commas = parseRow(header, ",").length;
  const semicolons = parseRow(header, ";").length;
  if (commas === expectedHeader.length && semicolons !== expectedHeader.length) return ",";
  if (semicolons === expectedHeader.length && commas !== expectedHeader.length) return ";";
  throw new TypeError("malformed record");
}

function quarantine(
  identity: StableIdentity,
  sourceRef: string,
  contentDigest: string,
  reason: QuarantineEntryV1["reason"],
): QuarantineEntryV1 {
  const evidenceId = identity.digest("company-money/evidence/nubank/v1", [
    sourceRef,
    contentDigest,
  ]);
  return {
    kind: "company-money.quarantine-entry",
    version: 1,
    id: identity.digest("company-money/quarantine/v1", [evidenceId, reason]),
    provider: "nubank",
    channel: "statement-csv",
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
    const oversized = Buffer.byteLength(serialized, "utf8") > MAX_NUBANK_STATEMENT_BYTES;
    return {
      digest: identity.digest("company-money/nubank-envelope/v1", [
        oversized ? "oversized" : serialized,
      ]),
      oversized,
    };
  } catch {
    return {
      digest: identity.digest("company-money/nubank-envelope/v1", ["unserializable"]),
      oversized: false,
    };
  }
}

function direction(value: string): TransactionCandidateV1["direction"] {
  if (value === "incoming") return "incoming";
  if (value === "outgoing") return "outgoing";
  throw new TypeError("malformed record");
}

function status(value: string): TransactionCandidateV1["status"] {
  if (
    value === "pending" ||
    value === "completed" ||
    value === "cancelled" ||
    value === "failed"
  ) {
    return value;
  }
  throw new TypeError("malformed record");
}

function currency(value: string): IsoCurrency {
  const normalized = value.trim().toUpperCase();
  IsoCurrencyV1Schema.assert(normalized);
  return normalized as IsoCurrency;
}

function candidateFromRow(
  fields: readonly string[],
  sourcePosition: string,
  sourceRef: string,
  options: NubankStatementTranslatorOptions,
): TransactionCandidateV1 {
  if (fields.length !== expectedHeader.length) throw new TypeError("malformed record");
  const bookedOn = fields[0].trim();
  CalendarDateV1Schema.assert(bookedOn);
  const selectedCurrency = currency(fields[2]);
  const selectedDirection = direction(fields[3].trim().toLowerCase());
  const selectedStatus = status(fields[4].trim().toLowerCase());
  const normalizedCounterparty = normalizeText(fields[6]);
  const normalizedReference = normalizeText(fields[7]);
  const providerTransactionId = normalizeText(fields[5]);
  const contentDigest = options.identity.digest("company-money/nubank-row-content/v1", fields);
  const evidenceId = options.identity.digest("company-money/evidence/nubank/v1", [
    sourceRef,
    sourcePosition,
    contentDigest,
  ]);
  const evidence = {
    kind: "company-money.evidence-ref" as const,
    version: 1 as const,
    id: evidenceId,
    provider: "nubank",
    channel: "statement-csv",
    sourceRef,
    contentDigest,
    grade: "primary" as const,
    parserId: PARSER_ID,
    parserVersion: 1 as const,
  };
  return {
    kind: "company-money.transaction-candidate",
    version: 1,
    entityId: options.entityId,
    accountAlias: options.accountAlias,
    provider: "nubank",
    occurredOn: bookedOn,
    bookedOn,
    money: {
      kind: "company-money.money",
      version: 1,
      currency: selectedCurrency,
      minorUnits: parseMinorUnits(fields[1], selectedCurrency),
    },
    direction: selectedDirection,
    status: selectedStatus,
    normalizedCounterparty,
    normalizedReference,
    providerTransactionId,
    sourcePosition,
    classification: options.classify({
      accountAlias: options.accountAlias,
      direction: selectedDirection,
      counterpartyEntityId: normalizedCounterparty,
      evidenceId,
    }),
    evidence,
  };
}

export function translateNubankStatement(
  value: unknown,
  options: NubankStatementTranslatorOptions,
): IngestBatchV1 {
  let envelope: NubankStatementEnvelopeV1;
  try {
    envelope = NubankStatementEnvelopeV1Schema.assert(value);
    if (
      envelope.accountAlias !== options.accountAlias ||
      envelope.accountAlias.length === 0 ||
      envelope.sourceRef.length === 0
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

  const statementDigest = options.identity.digest("company-money/nubank-statement/v1", [
    envelope.csv,
  ]);
  const lines = envelope.csv
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  if (lines.length < 2 || lines.length - 1 > MAX_NUBANK_STATEMENT_ROWS) {
    return {
      kind: "company-money.ingest-batch",
      version: 1,
      candidates: [],
      quarantine: [
        quarantine(
          options.identity,
          envelope.sourceRef,
          statementDigest,
          lines.length - 1 > MAX_NUBANK_STATEMENT_ROWS ? "size-limit" : "malformed-record",
        ),
      ],
    };
  }

  let delimiter: "," | ";";
  let rows: string[][];
  try {
    delimiter = delimiterFor(lines[0]);
    const header = parseRow(lines[0], delimiter).map((entry) => entry.trim().toLowerCase());
    if (!expectedHeader.every((entry, index) => header[index] === entry)) {
      throw new TypeError("malformed record");
    }
    rows = lines.slice(1).map((line) => parseRow(line, delimiter));
  } catch {
    return {
      kind: "company-money.ingest-batch",
      version: 1,
      candidates: [],
      quarantine: [
        quarantine(options.identity, envelope.sourceRef, statementDigest, "malformed-record"),
      ],
    };
  }

  rows.sort((left, right) => compareCodeUnits(JSON.stringify(left), JSON.stringify(right)));
  const candidates: TransactionCandidateV1[] = [];
  const quarantined: QuarantineEntryV1[] = [];
  rows.forEach((fields, index) => {
    const sourcePosition = `row:${index + 1}`;
    const rowDigest = options.identity.digest("company-money/nubank-row-content/v1", fields);
    try {
      candidates.push(
        candidateFromRow(fields, sourcePosition, envelope.sourceRef, options),
      );
    } catch {
      const rawCurrency = fields[2]?.trim().toUpperCase();
      const reason =
        rawCurrency && !Object.hasOwn(ISO_CURRENCY_MINOR_UNITS, rawCurrency)
          ? "unsupported-currency"
          : "malformed-record";
      quarantined.push(
        quarantine(
          options.identity,
          `${envelope.sourceRef}:${sourcePosition}`,
          rowDigest,
          reason,
        ),
      );
    }
  });
  return {
    kind: "company-money.ingest-batch",
    version: 1,
    candidates,
    quarantine: quarantined,
  };
}
