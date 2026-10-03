import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregate, markdown } from "./gate.ts";
import { digestPlan } from "./run.ts";
import type { Plan, Platform } from "./policy.ts";
import type { Receipt } from "./run.ts";

const jobs = { plan: "success", linux: "success", darwin: "success" };
function fixture() {
  const platforms: Platform[] = ["aarch64-darwin", "x86_64-linux"];
  const plan: Plan = {
    schemaVersion: 1,
    base: "a".repeat(40),
    head: "b".repeat(40),
    policyDigest: "c".repeat(64),
    blockers: [],
    autoMergeEligible: true,
    changes: [{ status: "M", path: "README.md" }],
    checks: platforms.map((platform) => ({
      id: "fixture",
      platform,
      phase: "runtime",
      reasons: ["fixture"],
      commands: [{ program: "node", args: ["--version"], timeoutSeconds: 5 }],
    })),
  };
  const receipts: Receipt[] = platforms.map((platform) => ({
    schemaVersion: 1,
    base: plan.base,
    head: plan.head,
    policyDigest: plan.policyDigest,
    planDigest: digestPlan(plan),
    platform,
    setup: [],
    errors: [],
    isolation: { controllerUid: 0, candidateUid: 62001 },
    results: [
      {
        id: "fixture",
        phase: "runtime",
        status: "passed",
        commands: [
          {
            program: "node",
            args: ["--version"],
            cwd: ".",
            status: "passed",
            exitCode: 0,
            signal: null,
            durationMs: 1,
            log: "fixture.log",
          },
        ],
      },
    ],
  }));
  return { plan, receipts };
}

test("only complete native evidence and actual successful jobs make merge-ready green", () => {
  const { plan, receipts } = fixture();
  assert.deepEqual(aggregate(plan, receipts, jobs), {
    status: "passed",
    errors: [],
    autoMergeEligible: true,
  });
});

test("failed, skipped, cancelled, pending and missing jobs never become success", () => {
  const { plan, receipts } = fixture();
  for (const state of ["failure", "skipped", "cancelled", "pending", ""]) {
    assert.equal(aggregate(plan, receipts, { ...jobs, darwin: state }).status, "failed");
    assert.equal(aggregate(plan, receipts, { ...jobs, plan: state }).status, "failed");
  }
});

test("same-user or missing controller separation never makes hosted evidence green", () => {
  for (const isolation of [
    null,
    { controllerUid: 1000, candidateUid: 1000 },
    { controllerUid: 0, candidateUid: 0 },
  ]) {
    const { plan, receipts } = fixture();
    receipts[0].isolation = isolation;
    assert.equal(aggregate(plan, receipts, jobs).status, "failed");
  }
});

test("missing, duplicate, unexpected and stale platform evidence fails closed", () => {
  for (const mutate of [
    (receipts: Receipt[]) => {
      receipts.pop();
    },
    (receipts: Receipt[]) => {
      receipts.push(receipts[0]);
    },
    (receipts: Receipt[]) => {
      receipts[0].head = "d".repeat(40);
    },
    (receipts: Receipt[]) => {
      receipts[0].base = "d".repeat(40);
    },
    (receipts: Receipt[]) => {
      receipts[0].policyDigest = "d".repeat(64);
    },
    (receipts: Receipt[]) => {
      receipts[0].planDigest = "d".repeat(64);
    },
    (receipts: Receipt[]) => {
      receipts[0].platform = "aarch64-linux" as never;
    },
  ]) {
    const { plan, receipts } = fixture();
    mutate(receipts);
    assert.equal(aggregate(plan, receipts, jobs).status, "failed");
  }
});

test("missing, duplicate, blocked, substituted and partially executed checks fail", () => {
  for (const mutate of [
    (receipt: Receipt) => {
      receipt.results = [];
    },
    (receipt: Receipt) => {
      receipt.results.push(receipt.results[0]);
    },
    (receipt: Receipt) => {
      receipt.results[0].status = "blocked";
    },
    (receipt: Receipt) => {
      receipt.results[0].phase = "host";
    },
    (receipt: Receipt) => {
      receipt.results[0].commands = [];
    },
    (receipt: Receipt) => {
      receipt.results[0].commands[0].args = ["different"];
    },
    (receipt: Receipt) => {
      receipt.results[0].commands[0].exitCode = 4;
    },
    (receipt: Receipt) => {
      receipt.results[0].commands[0].signal = "SIGTERM";
    },
    (receipt: Receipt) => {
      receipt.results[0].commands[0].status = "timed-out";
    },
    (receipt: Receipt) => {
      receipt.results.push({ id: "unplanned", phase: "local", status: "passed", commands: [] });
    },
  ]) {
    const { plan, receipts } = fixture();
    mutate(receipts[0]);
    assert.equal(aggregate(plan, receipts, jobs).status, "failed");
  }
});

test("policy blockers and worker errors remain blocking regardless of green commands", () => {
  const { plan, receipts } = fixture();
  receipts[0].errors.push("network unavailable");
  assert.equal(aggregate(plan, receipts, jobs).status, "failed");
  plan.blockers.push("missing reload probe");
  assert.equal(aggregate(plan, fixture().receipts, jobs).status, "failed");
});

test("Pi-dependent checks require actual frozen installation evidence", () => {
  const { plan, receipts } = fixture();
  plan.checks[0].commands[0].args = ["scripts/ci/probes.ts", "pi"];
  receipts.forEach((receipt) => {
    receipt.planDigest = digestPlan(plan);
  });
  receipts[0].results[0].commands[0].args = plan.checks[0].commands[0].args;
  assert.equal(aggregate(plan, receipts, jobs).status, "failed");
  receipts[0].setup = [
    {
      program: "pnpm",
      args: ["install", "--frozen-lockfile"],
      cwd: "modules/pi",
      status: "passed",
      exitCode: 0,
      signal: null,
      durationMs: 1,
      log: "setup.log",
    },
  ];
  assert.equal(aggregate(plan, receipts, jobs).status, "passed");
});

test("manual-review changes can pass verification without becoming automerge-eligible", () => {
  const { plan, receipts } = fixture();
  plan.autoMergeEligible = false;
  receipts.forEach((receipt) => {
    receipt.planDigest = digestPlan(plan);
  });
  const verdict = aggregate(plan, receipts, jobs);
  assert.equal(verdict.status, "passed");
  assert.equal(verdict.autoMergeEligible, false);
  assert.match(markdown(plan, verdict), /automatic merge eligible: \*\*false\*\*/);
});
