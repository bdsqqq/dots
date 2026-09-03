import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";

import { type } from "arktype";

import type { TransactionCandidateV1 } from "./ledger/ingest.ts";
import type { TransferReconciliationPolicy } from "./ledger/link-transfers.ts";
import type { ClassificationV1, ClassificationValue } from "./ledger/state.ts";
import { compareCodeUnits } from "./money.ts";

const MAX_PRIVATE_CONFIG_BYTES = 256 * 1024;
const NonEmptyStringV1Schema = type("string").narrow(
  (value, context) => value.length > 0 || context.mustBe("a non-empty string"),
);

const AccountV1Schema = type({
  "+": "reject",
  alias: NonEmptyStringV1Schema,
  provider: "'nubank' | 'wise'",
});
const EntityAliasV1Schema = type({
  "+": "reject",
  entityId: NonEmptyStringV1Schema,
  alias: NonEmptyStringV1Schema,
});
const OwnerFundingRuleV1Schema = type({
  "+": "reject",
  ruleId: NonEmptyStringV1Schema,
  accountAlias: NonEmptyStringV1Schema,
  counterpartyEntityId: NonEmptyStringV1Schema,
});
const InternalTransferRuleV1Schema = type({
  "+": "reject",
  ruleId: NonEmptyStringV1Schema,
  outgoingAccountAlias: NonEmptyStringV1Schema,
  incomingAccountAlias: NonEmptyStringV1Schema,
  outgoingCounterpartyEntityId: NonEmptyStringV1Schema,
  incomingCounterpartyEntityId: NonEmptyStringV1Schema,
});
const ClassificationRuleV1Schema = type({
  "+": "reject",
  ruleId: NonEmptyStringV1Schema,
  value: "'revenue' | 'expense' | 'cashback'",
  accountAlias: NonEmptyStringV1Schema,
  direction: "'incoming' | 'outgoing'",
  counterpartyEntityId: "string | null",
});

export const PrivateConfigV1Schema = type({
  "+": "reject",
  kind: "'company-money.private-config'",
  version: "1",
  entityId: NonEmptyStringV1Schema,
  accounts: AccountV1Schema.array(),
  entityAliases: EntityAliasV1Schema.array(),
  ownerFundingRules: OwnerFundingRuleV1Schema.array(),
  internalTransferRules: InternalTransferRuleV1Schema.array(),
  classificationRules: ClassificationRuleV1Schema.array(),
}).narrow((config, context) => {
  const accountAliases = config.accounts.map((entry) => entry.alias);
  const providers = config.accounts.map((entry) => entry.provider);
  const entityIds = config.entityAliases.map((entry) => entry.entityId);
  const ruleIds = [
    ...config.ownerFundingRules,
    ...config.internalTransferRules,
    ...config.classificationRules,
  ].map((entry) => entry.ruleId);
  const known = new Set(accountAliases);
  const referencedAliases = [
    ...config.ownerFundingRules.map((entry) => entry.accountAlias),
    ...config.internalTransferRules.flatMap((entry) => [
      entry.outgoingAccountAlias,
      entry.incomingAccountAlias,
    ]),
    ...config.classificationRules.map((entry) => entry.accountAlias),
  ];
  return (
    (new Set(accountAliases).size === accountAliases.length ||
      context.mustBe("unique account aliases")) &&
    (new Set(providers).size === providers.length ||
      context.mustBe("at most one account alias per provider")) &&
    (new Set(entityIds).size === entityIds.length ||
      context.mustBe("unique canonical entity alias keys")) &&
    (new Set(ruleIds).size === ruleIds.length || context.mustBe("unique rule ids")) &&
    (referencedAliases.every((alias) => known.has(alias)) ||
      context.mustBe("rules that reference configured account aliases")) &&
    (config.internalTransferRules.every(
      (entry) => entry.outgoingAccountAlias !== entry.incomingAccountAlias,
    ) || context.mustBe("internal transfers between distinct accounts"))
  );
});

export type PrivateConfigV1 = typeof PrivateConfigV1Schema.infer;

export const privateConfigSchemaCatalog = {
  "company-money.private-config": { 1: PrivateConfigV1Schema },
} as const;

export async function loadPrivateConfig(path: string): Promise<PrivateConfigV1> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new Error("private configuration is unavailable");
  }
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    (info.mode & 0o777) !== 0o600 ||
    info.size > MAX_PRIVATE_CONFIG_BYTES
  ) {
    throw new Error("private configuration is unavailable");
  }
  try {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      bytes = await readFile(handle);
    } finally {
      await handle.close();
    }
    if (bytes.length > MAX_PRIVATE_CONFIG_BYTES) {
      throw new Error("private configuration is unavailable");
    }
    return PrivateConfigV1Schema.assert(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw new Error("private configuration is unavailable");
  }
}

export function accountAliasForProvider(
  config: PrivateConfigV1,
  provider: "nubank" | "wise",
): string {
  const account = config.accounts.find((entry) => entry.provider === provider);
  if (!account) throw new Error("provider account is not configured");
  return account.alias;
}

export function displayAlias(config: PrivateConfigV1, entityId: string): string {
  return config.entityAliases.find((entry) => entry.entityId === entityId)?.alias ?? entityId;
}

export interface ClassificationFacts {
  readonly accountAlias: string;
  readonly direction: TransactionCandidateV1["direction"];
  readonly counterpartyEntityId: string | null;
  readonly evidenceId: string;
}

function classification(
  value: ClassificationValue,
  confidence: ClassificationV1["confidence"],
  basis: string,
  ruleId: string | null,
  evidenceId: string,
): ClassificationV1 {
  return {
    kind: "company-money.classification",
    version: 1,
    value,
    confidence,
    basis,
    ruleId,
    evidenceIds: [evidenceId],
  };
}

export function classifyEvidence(
  config: PrivateConfigV1,
  facts: ClassificationFacts,
  suggested: "cashback" | null = null,
): ClassificationV1 {
  const internal = [...config.internalTransferRules]
    .sort((left, right) => compareCodeUnits(left.ruleId, right.ruleId))
    .find(
      (rule) =>
        (facts.direction === "outgoing" &&
          facts.accountAlias === rule.outgoingAccountAlias &&
          facts.counterpartyEntityId === rule.outgoingCounterpartyEntityId) ||
        (facts.direction === "incoming" &&
          facts.accountAlias === rule.incomingAccountAlias &&
          facts.counterpartyEntityId === rule.incomingCounterpartyEntityId),
    );
  if (internal) {
    return classification(
      "internal-transfer",
      "confirmed",
      "private-rule",
      internal.ruleId,
      facts.evidenceId,
    );
  }
  const ownerFunding = [...config.ownerFundingRules]
    .sort((left, right) => compareCodeUnits(left.ruleId, right.ruleId))
    .find(
      (rule) =>
        facts.direction === "incoming" &&
        facts.accountAlias === rule.accountAlias &&
        facts.counterpartyEntityId === rule.counterpartyEntityId,
    );
  if (ownerFunding) {
    return classification(
      "owner-funding",
      "confirmed",
      "private-rule",
      ownerFunding.ruleId,
      facts.evidenceId,
    );
  }
  const configured = [...config.classificationRules]
    .sort((left, right) => compareCodeUnits(left.ruleId, right.ruleId))
    .find(
      (rule) =>
        facts.accountAlias === rule.accountAlias &&
        facts.direction === rule.direction &&
        (rule.counterpartyEntityId === null ||
          facts.counterpartyEntityId === rule.counterpartyEntityId),
    );
  if (configured) {
    return classification(
      configured.value,
      "confirmed",
      "private-rule",
      configured.ruleId,
      facts.evidenceId,
    );
  }
  if (suggested) {
    return classification(
      suggested,
      "strong",
      "provider-template",
      null,
      facts.evidenceId,
    );
  }
  return classification("unclassified", "tentative", "unresolved", null, facts.evidenceId);
}

export function transferPolicy(config: PrivateConfigV1): TransferReconciliationPolicy {
  const pairs = new Set(
    config.internalTransferRules.map(
      (rule) => `${rule.outgoingAccountAlias}\0${rule.incomingAccountAlias}`,
    ),
  );
  return {
    isEligibleAccountPair: (outgoingAlias, incomingAlias) =>
      pairs.has(`${outgoingAlias}\0${incomingAlias}`),
  };
}
