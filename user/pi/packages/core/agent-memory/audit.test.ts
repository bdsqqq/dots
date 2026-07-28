import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditResumeCommand,
  auditSessionDir,
  listAuditSessions,
  modelConfig,
  prepareAuditInvocation,
} from "./audit.js";

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});

describe("background model audit sessions", () => {
  it("validates separate explicit model and reasoning configuration", () => {
    delete process.env.PI_MEMORY_MODEL;
    delete process.env.PI_MEMORY_REASONING_LEVEL;
    expect(modelConfig()).toEqual({
      model: "openai-codex/gpt-5.6-luna",
      reasoning: "low",
    });
    process.env.PI_MEMORY_MODEL = "openai-codex/gpt-5.6-luna:high";
    expect(() => modelConfig()).toThrow("without thinking shorthand");
    process.env.PI_MEMORY_MODEL = "openai-codex/gpt-5.6-luna";
    process.env.PI_MEMORY_REASONING_LEVEL = "turbo";
    expect(() => modelConfig()).toThrow("must be one of");
  });

  it("persists a deterministic isolated session with model, thinking, and usage", () => {
    const base = mkdtempSync(join(tmpdir(), "pi-memory-audit-"));
    const data = join(base, "data");
    const normal = join(base, "normal-sessions");
    process.env.PI_MEMORY_SESSION_DIR = join(base, "audit-sessions");
    const fake = join(base, "fake-pi.mjs");
    writeFileSync(
      fake,
      `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const dir = value("--session-dir");
const id = value("--session-id");
const model = value("--model");
const thinking = value("--thinking");
const name = value("--name");
mkdirSync(dir, { recursive: true });
const records = [
  { type: "session", version: 3, id, cwd: process.cwd() },
  { type: "session_info", id: "name0001", parentId: null, name },
  { type: "model_change", id: "model001", parentId: "name0001", provider: model.split("/")[0], modelId: model.split("/").slice(1).join("/") },
  { type: "thinking_level_change", id: "think001", parentId: "model001", thinkingLevel: thinking },
  { type: "thinking_level_change", id: "abandoned", parentId: "model001", thinkingLevel: "high" },
  { type: "message", id: "prompt01", parentId: "think001", message: { role: "user", content: "bounded prompt" } },
  { type: "message", id: "reply001", parentId: "prompt01", message: { role: "assistant", model: model.split("/").slice(1).join("/"), provider: model.split("/")[0], content: [{ type: "text", text: "ok" }], stopReason: "stop", usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 6, cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 } } } },
];
writeFileSync(join(dir, \`2026-01-01T00-00-00-000Z_\${id}.jsonl\`), records.map(JSON.stringify).join("\\n") + "\\n");
process.stdout.write("untrusted stdout");
`,
    );
    chmodSync(fake, 0o700);
    const first = prepareAuditInvocation({
      data,
      kind: "reflection",
      identity: "run_abc",
      runId: "run_abc",
      prompt: "bounded prompt",
      model: "openai-codex/gpt-5.6-luna",
      reasoning: "low",
    });
    expect(first.args).toEqual(
      expect.arrayContaining([
        "--session-dir",
        auditSessionDir(data),
        "--session-id",
        first.record.sessionId,
        "--model",
        "openai-codex/gpt-5.6-luna",
        "--thinking",
        "low",
        "--no-extensions",
        "--no-tools",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
      ]),
    );
    expect(first.args).not.toContain("--no-session");
    const child = spawnSync(fake, first.args, {
      input: "bounded prompt",
      encoding: "utf8",
    });
    expect({ status: child.status, stderr: child.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    const persistedSession = join(
      auditSessionDir(data),
      readdirSync(auditSessionDir(data)).find((name) =>
        name.endsWith(`_${first.record.sessionId}.jsonl`),
      )!,
    );
    const pristineSession = readFileSync(persistedSession, "utf8");
    writeFileSync(
      persistedSession,
      pristineSession.replace('"stopReason":"stop"', '"stopReason":"length"'),
    );
    expect(() => first.complete()).toThrow("did not complete successfully");
    writeFileSync(
      persistedSession,
      pristineSession.replace(
        '"thinkingLevel":"low"',
        '"thinkingLevel":"high"',
      ),
    );
    expect(() => first.complete()).toThrow("effective configuration mismatch");
    writeFileSync(persistedSession, pristineSession);
    const complete = first.complete();
    expect(complete.record.sessionPath).toBeTruthy();
    expect(complete.output).toBe("ok");
    const second = prepareAuditInvocation({
      data,
      kind: "reflection",
      identity: "run_abc",
      runId: "run_abc",
      prompt: "bounded prompt",
      model: "openai-codex/gpt-5.6-luna",
      reasoning: "low",
    });
    expect(second.record.sessionId).toBe(first.record.sessionId);
    expect(second.record.model).toBe("openai-codex/gpt-5.6-luna");
    expect(second.recoveredOutput).toBe("ok");
    expect(() =>
      prepareAuditInvocation({
        data,
        kind: "reflection",
        identity: "run_abc",
        runId: "run_abc",
        prompt: "bounded prompt",
        model: "different/model",
        reasoning: "high",
      }),
    ).toThrow("configuration drift");
    const session = readFileSync(complete.record.sessionPath!, "utf8");
    expect(session).toMatch(/"type":"session"/);
    expect(session).toMatch(/"model":"gpt-5.6-luna"/);
    expect(session).toMatch(/"thinkingLevel":"low"/);
    expect(session).toMatch(/"usage":/);
    expect(listAuditSessions(data)[0]).toMatchObject({
      kind: "reflection",
      sessionId: first.record.sessionId,
      model: "openai-codex/gpt-5.6-luna",
      reasoning: "low",
      status: "complete",
      usage: { input: 3, output: 2, totalTokens: 6, cost: 0.31 },
    });
    expect(existsSync(normal)).toBe(false);
    expect(auditResumeCommand(data)).toBe(
      `pi --session-dir '${auditSessionDir(data)}' -r --no-tools --no-extensions --no-skills --no-prompt-templates --no-context-files`,
    );
  });

  it("rejects unpublished configuration drift before a session exists", () => {
    const base = mkdtempSync(join(tmpdir(), "pi-memory-audit-drift-"));
    process.env.PI_MEMORY_SESSION_DIR = join(base, "sessions");
    prepareAuditInvocation({
      data: join(base, "data"),
      kind: "adaptation",
      identity: "event",
      eventId: "event",
      prompt: "prompt",
      model: "provider/model-a",
      reasoning: "low",
    });
    expect(() =>
      prepareAuditInvocation({
        data: join(base, "data"),
        kind: "adaptation",
        identity: "event",
        eventId: "event",
        prompt: "prompt",
        model: "provider/model-b",
        reasoning: "high",
      }),
    ).toThrow("configuration drift");
  });

  it("lists incomplete invocations without hiding complete sessions", () => {
    const base = mkdtempSync(join(tmpdir(), "pi-memory-audit-pending-"));
    const data = join(base, "data");
    process.env.PI_MEMORY_SESSION_DIR = join(base, "sessions");
    const pending = prepareAuditInvocation({
      data,
      kind: "corpus-doctor",
      identity: "pending-event",
      eventId: "pending-event",
      prompt: "prompt",
      model: "provider/model",
      reasoning: "low",
    });
    mkdirSync(auditSessionDir(data), { recursive: true });
    writeFileSync(
      join(
        auditSessionDir(data),
        `2026-01-01T00-00-00-000Z_${pending.record.sessionId}.jsonl`,
      ),
      `${[
        {
          type: "session",
          version: 3,
          id: pending.record.sessionId,
          cwd: process.cwd(),
        },
        {
          type: "model_change",
          id: "model",
          parentId: null,
          provider: "provider",
          modelId: "model",
        },
        {
          type: "thinking_level_change",
          id: "thinking",
          parentId: "model",
          thinkingLevel: "low",
        },
        {
          type: "message",
          id: "abandoned-user",
          parentId: "thinking",
          message: { role: "user", content: "prompt" },
        },
        {
          type: "message",
          id: "abandoned-assistant",
          parentId: "abandoned-user",
          message: {
            role: "assistant",
            provider: "provider",
            model: "model",
            content: [{ type: "text", text: "abandoned output" }],
            stopReason: "stop",
            usage: {
              input: 3,
              output: 2,
              cacheRead: 1,
              cacheWrite: 0,
              totalTokens: 6,
              cost: { total: 0.31 },
            },
          },
        },
        {
          type: "message",
          id: "active-user",
          parentId: "thinking",
          message: { role: "user", content: "prompt" },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    );
    expect(listAuditSessions(data)).toEqual([
      expect.objectContaining({
        sessionId: pending.record.sessionId,
        sessionPath: null,
        status: "pending",
        usage: {
          input: 3,
          output: 2,
          cacheRead: 1,
          cacheWrite: 0,
          totalTokens: 6,
          cost: 0.31,
        },
      }),
    ]);
    const retry = prepareAuditInvocation({
      data,
      kind: "corpus-doctor",
      identity: "pending-event",
      eventId: "pending-event",
      prompt: "prompt",
      model: "provider/model",
      reasoning: "low",
    });
    expect(retry.record).toMatchObject({
      attempt: 1,
      sessionPath: null,
      previousAttempts: [
        {
          sessionId: pending.record.sessionId,
          status: "incomplete",
        },
      ],
    });
    expect(retry.record.sessionId).not.toBe(pending.record.sessionId);
    expect(retry.args).toEqual(
      expect.arrayContaining(["--session-id", retry.record.sessionId]),
    );
    expect(listAuditSessions(data)[0]).toMatchObject({
      status: "pending",
      missingAttempts: 0,
      usage: { input: 3, output: 2, totalTokens: 6, cost: 0.31 },
    });
  });
});
