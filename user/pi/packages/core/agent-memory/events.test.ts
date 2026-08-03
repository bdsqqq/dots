import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MemoryConfig } from "./catalog.js";
import { withMemoryWideEventFactory } from "./observability.js";
import {
  claimMaintenanceEvent,
  completeMaintenanceEvent,
  enqueueMaintenanceEvent,
  failMaintenanceEvent,
  listMaintenanceEvents,
  parseMaintenanceEvent,
  recoverMaintenanceEvents,
  type MaintenanceEventKind,
} from "./events.js";

const CREATED = "2026-07-26T10:00:00.000Z";
const CLAIMED = "2026-07-26T10:01:00.000Z";
const CLAIMED_LATE = "2026-07-26T10:09:00.000Z";
const RECOVERED = "2026-07-26T10:10:00.000Z";

function config(): MemoryConfig {
  const base = mkdtempSync(join(tmpdir(), "pi-memory-events-"));
  return {
    state: join(base, "state"),
    data: join(base, "data"),
    root: join(base, "memories"),
    skillsRoot: join(base, "skills"),
  };
}

function enqueue(
  cfg: MemoryConfig,
  kind: MaintenanceEventKind = "manual",
  basis: Record<string, string> = { request: "one" },
) {
  return enqueueMaintenanceEvent(
    cfg,
    { kind, cause: "test trigger", basis },
    () => CREATED,
  );
}

describe("maintenance event queue", () => {
  it("deduplicates autonomous tier classification and evaluation triggers", () => {
    const cfg = config();
    const tiering = enqueue(cfg, "tiering-ready");
    const duplicate = enqueue(cfg, "tiering-ready");
    const evaluation = enqueue(cfg, "tier-eval-ready");
    expect(duplicate.id).toBe(tiering.id);
    expect(evaluation.id).not.toBe(tiering.id);
  });

  it("enqueues exclusively with a deterministic canonical id", () => {
    const cfg = config();
    const first = enqueue(cfg, "corpus-changed", { z: "last", a: "first" });
    const duplicate = enqueue(cfg, "corpus-changed", {
      a: "first",
      z: "last",
    });

    expect(duplicate).toEqual(first);
    expect(first.id).toMatch(/^event_[0-9a-f]{64}$/);
    expect(listMaintenanceEvents(cfg)).toEqual([
      { status: "pending", event: first },
    ]);
    expect(
      readFileSync(
        join(cfg.data, `v2/events/pending/${first.id}.json`),
        "utf8",
      ),
    ).toContain('"version": 1');
  });

  it("strictly rejects unknown fields, invalid ids, and malformed files", () => {
    const cfg = config();
    const event = enqueue(cfg);
    const raw = JSON.stringify(event);
    expect(() =>
      parseMaintenanceEvent(raw.replace('"version":1', '"version":2')),
    ).toThrow("invalid maintenance event version");
    expect(() =>
      parseMaintenanceEvent(JSON.stringify({ ...event, extra: true })),
    ).toThrow("invalid maintenance event fields");
    expect(() =>
      parseMaintenanceEvent(JSON.stringify({ ...event, cause: "changed" })),
    ).toThrow("invalid maintenance event id hash");

    writeFileSync(
      join(cfg.data, "v2/events/pending", `${event.id}.json`),
      "not-json",
    );
    expect(() => listMaintenanceEvents(cfg)).toThrow(
      "invalid maintenance event json",
    );
  });

  it("lists deterministically by event id", () => {
    const cfg = config();
    enqueue(cfg, "manual", { request: "z" });
    enqueue(cfg, "checkpoint-ready", { request: "a" });
    enqueue(cfg, "corpus-changed", { request: "m" });

    const ids = listMaintenanceEvents(cfg).map(({ event }) => event.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("claims by rename and increments attempt metadata", () => {
    const cfg = config();
    const pending = enqueue(cfg);
    const claimed = claimMaintenanceEvent(cfg, {
      ownerPid: 4242,
      clock: () => CLAIMED,
    });

    expect(claimed).toMatchObject({
      id: pending.id,
      attempt: 1,
      ownerPid: 4242,
      claimedAt: CLAIMED,
    });
    expect(
      existsSync(join(cfg.data, `v2/events/pending/${pending.id}.json`)),
    ).toBe(false);
    expect(
      existsSync(join(cfg.data, `v2/events/processing/${pending.id}.json`)),
    ).toBe(true);
    expect(claimMaintenanceEvent(cfg)).toBeNull();
  });

  it("recovers a claim interrupted immediately after rename", () => {
    const cfg = config();
    const event = enqueue(cfg);
    renameSync(
      join(cfg.data, `v2/events/pending/${event.id}.json`),
      join(cfg.data, `v2/events/processing/${event.id}.json`),
    );

    expect(recoverMaintenanceEvents(cfg, { clock: () => CLAIMED })).toEqual([
      event,
    ]);
    expect(listMaintenanceEvents(cfg)).toEqual([{ status: "pending", event }]);
  });

  it("recovers only processing events whose owner pid is dead", () => {
    const cfg = config();
    const first = enqueue(cfg, "manual", { request: "dead" });
    claimMaintenanceEvent(cfg, { ownerPid: 111, clock: () => CLAIMED });
    const second = enqueue(cfg, "manual", { request: "alive" });
    claimMaintenanceEvent(cfg, { ownerPid: 222, clock: () => CLAIMED_LATE });

    expect(recoverMaintenanceEvents(cfg, { clock: () => RECOVERED })).toEqual([
      expect.objectContaining({ id: first.id, attempt: 1 }),
    ]);
    expect(listMaintenanceEvents(cfg)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "pending",
          event: { ...first, attempt: 1 },
        }),
        expect.objectContaining({
          status: "processing",
          event: expect.objectContaining({ id: second.id, ownerPid: 222 }),
        }),
      ]),
    );
  });

  it("does not replace an active claim when the same event is enqueued", () => {
    const cfg = config();
    const event = enqueue(cfg);
    const claimed = claimMaintenanceEvent(cfg, {
      ownerPid: 111,
      clock: () => CLAIMED,
    })!;
    expect(enqueue(cfg)).toEqual(claimed);
    expect(listMaintenanceEvents(cfg)).toEqual([
      { status: "processing", event: claimed },
    ]);
    expect(() => completeMaintenanceEvent(cfg, event.id, randomUUID())).toThrow(
      "owner mismatch",
    );
    expect(
      completeMaintenanceEvent(cfg, event.id, claimed.claimToken!).id,
    ).toBe(event.id);
  });

  it("moves claimed events to done and failed terminal directories", () => {
    const cfg = config();
    const done = enqueue(cfg, "manual", { request: "done" });
    const doneClaim = claimMaintenanceEvent(cfg, {
      ownerPid: 1,
      clock: () => CLAIMED,
    })!;
    expect(
      completeMaintenanceEvent(cfg, done.id, doneClaim.claimToken!),
    ).toMatchObject({
      id: done.id,
    });

    const failed = enqueue(cfg, "manual", { request: "failed" });
    const failedClaim = claimMaintenanceEvent(cfg, {
      ownerPid: 1,
      clock: () => CLAIMED,
    })!;
    expect(
      failMaintenanceEvent(cfg, failed.id, failedClaim.claimToken!),
    ).toMatchObject({
      id: failed.id,
    });
    expect(
      listMaintenanceEvents(cfg)
        .map(({ status }) => status)
        .sort(),
    ).toEqual(["done", "failed"]);
  });

  it("emits one enqueue terminal and ignores logging failure", () => {
    const finishes = vi.fn();
    const event = withMemoryWideEventFactory(
      () => ({ id: "test", set: vi.fn(), error: vi.fn(), finish: finishes }),
      () => enqueue(config()),
    );
    expect(finishes).toHaveBeenCalledOnce();
    expect(finishes).toHaveBeenCalledWith("success", {
      eventId: event.id,
      attempt: 0,
    });

    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      withMemoryWideEventFactory(
        () => {
          throw new Error("offline");
        },
        () => enqueue(config()),
      ).id,
    ).toMatch(/^event_/);
    expect(stderr).toHaveBeenCalledOnce();
    stderr.mockRestore();
  });
});
