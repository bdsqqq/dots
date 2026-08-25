import { describe, expect, it } from "vitest";
import {
  canonicalTurnReceiptId,
  parseInjectionReceipt,
  parseTurnReceipt,
  type MemoryRef,
  type TurnReceipt,
} from "./receipt.js";

const HASH = "a".repeat(64);
const REF: MemoryRef = {
  memoryId: "mem_test",
  path: "test--source__agent.md",
  artifactSha256: HASH,
};
const NOW = "2026-08-03T00:00:00.000Z";

function canonicalReceipt(
  identity: Omit<TurnReceipt, "receiptId">,
): TurnReceipt {
  return { ...identity, receiptId: canonicalTurnReceiptId(identity) };
}

describe("memory receipts", () => {
  it("preserves strict v1 injection and turn receipt parsing", () => {
    expect(
      parseInjectionReceipt({
        version: 1,
        userEntryId: "u1",
        catalogSha256: HASH,
        refs: [REF],
      }),
    ).toMatchObject({ version: 1, refs: [REF] });
    const receipt = canonicalReceipt({
      version: 1,
      sessionId: "session-1",
      workspace: "/workspace",
      userEntryIds: ["u1"],
      assistantEntryIds: ["a1"],
      catalogSha256: HASH,
      exposures: [
        {
          kind: "injected",
          memoryId: REF.memoryId,
          artifactSha256: REF.artifactSha256,
        },
      ],
      outcomes: [],
      redactions: {},
      recordedAt: NOW,
    });
    expect(parseTurnReceipt(receipt)).toEqual(receipt);
  });

  it("binds canonical v2 identity to exact system and external exposure", () => {
    const external = { ...REF, memoryId: "mem_external", path: "external.md" };
    const identity: Omit<TurnReceipt, "receiptId"> = {
      version: 2,
      sessionId: "session-1",
      workspace: "/workspace",
      userEntryIds: ["u1"],
      assistantEntryIds: ["a1"],
      catalogSha256: HASH,
      systemRefs: [REF],
      externalPointerRefs: [external],
      snapshotSha256: "b".repeat(64),
      rolloutArm: "canary",
      exposures: [
        {
          kind: "system-injected",
          memoryId: REF.memoryId,
          artifactSha256: REF.artifactSha256,
        },
        {
          kind: "external-pointer",
          memoryId: external.memoryId,
          artifactSha256: external.artifactSha256,
        },
      ],
      outcomes: [],
      redactions: {},
      recordedAt: NOW,
    };
    const receipt = canonicalReceipt(identity);
    expect(parseTurnReceipt(receipt)).toEqual(receipt);
    expect(() =>
      parseTurnReceipt({
        ...receipt,
        rolloutArm: "active",
      }),
    ).toThrow("id does not match content");
    expect(() =>
      parseTurnReceipt(
        canonicalReceipt({
          ...identity,
          exposures: identity.exposures.filter(
            (item) => item.kind !== "external-pointer",
          ),
        }),
      ),
    ).toThrow("exposure does not match snapshot");
  });
});
