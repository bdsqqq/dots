import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PrivateConfigV1Schema,
  classifyEvidence,
  displayAlias,
  loadPrivateConfig,
  transferPolicy,
  type PrivateConfigV1,
} from "./private-config.ts";

function config(): PrivateConfigV1 {
  return {
    kind: "company-money.private-config",
    version: 1,
    entityId: "Example Widgets Ltd.",
    accounts: [
      { alias: "operating", provider: "nubank" },
      { alias: "reserve", provider: "wise" },
    ],
    entityAliases: [
      { entityId: "Synthetic Person One", alias: "owner" },
      { entityId: "Synthetic Person Two", alias: "owner" },
    ],
    ownerFundingRules: [
      {
        ruleId: "owner-funding",
        accountAlias: "operating",
        counterpartyEntityId: "Synthetic Person One",
      },
    ],
    internalTransferRules: [
      {
        ruleId: "reserve-to-operating",
        outgoingAccountAlias: "reserve",
        incomingAccountAlias: "operating",
        outgoingCounterpartyEntityId: "Example Operating Account",
        incomingCounterpartyEntityId: "Example Reserve Account",
      },
    ],
    classificationRules: [
      {
        ruleId: "synthetic-revenue",
        value: "revenue",
        accountAlias: "operating",
        direction: "incoming",
        counterpartyEntityId: "Synthetic Customer LLC",
      },
    ],
  };
}

test("private aliases group canonical ids without changing canonical identity", () => {
  const value = config();
  assert.equal(PrivateConfigV1Schema.assert(value), value);
  assert.equal(displayAlias(value, "Synthetic Person One"), "owner");
  assert.equal(displayAlias(value, "Synthetic Person Two"), "owner");
  assert.equal(displayAlias(value, "Unknown Legal Entity"), "Unknown Legal Entity");
  assert.equal(value.entityId, "Example Widgets Ltd.");
});

test("private policy confirms owner funding, internal transfers, and explicit classes", () => {
  const value = config();
  assert.equal(
    classifyEvidence(value, {
      accountAlias: "operating",
      direction: "incoming",
      counterpartyEntityId: "Synthetic Person One",
      evidenceId: "evidence-owner",
    }).value,
    "owner-funding",
  );
  assert.equal(
    classifyEvidence(value, {
      accountAlias: "reserve",
      direction: "outgoing",
      counterpartyEntityId: "Example Operating Account",
      evidenceId: "evidence-transfer",
    }).value,
    "internal-transfer",
  );
  assert.equal(
    classifyEvidence(value, {
      accountAlias: "operating",
      direction: "incoming",
      counterpartyEntityId: "Synthetic Customer LLC",
      evidenceId: "evidence-revenue",
    }).value,
    "revenue",
  );
  assert.equal(
    classifyEvidence(
      value,
      {
        accountAlias: "reserve",
        direction: "incoming",
        counterpartyEntityId: null,
        evidenceId: "evidence-cashback",
      },
      "cashback",
    ).confidence,
    "strong",
  );
  assert.equal(transferPolicy(value).isEligibleAccountPair("reserve", "operating"), true);
});

test("config loading requires an exact regular 0600 file and valid references", async () => {
  const root = await mkdtemp(join(tmpdir(), "company-money-config-"));
  try {
    const path = join(root, "config.json");
    await writeFile(path, JSON.stringify(config()), { mode: 0o600 });
    assert.deepEqual(await loadPrivateConfig(path), config());
    await chmod(path, 0o644);
    await assert.rejects(() => loadPrivateConfig(path), /unavailable/);
    await chmod(path, 0o600);
    const link = join(root, "link.json");
    await symlink(path, link);
    await assert.rejects(() => loadPrivateConfig(link), /unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  assert.throws(
    () =>
      PrivateConfigV1Schema.assert({
        ...config(),
        accounts: [{ alias: "operating", provider: "nubank" }],
        extra: true,
      }),
    /extra/,
  );
  assert.throws(
    () =>
      PrivateConfigV1Schema.assert({
        ...config(),
        ownerFundingRules: [
          {
            ruleId: "unknown-account",
            accountAlias: "missing",
            counterpartyEntityId: "Synthetic Person One",
          },
        ],
      }),
    /configured account/,
  );
});
