import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolvedConversation } from "./core/config-types.js";
import type { ChatLogRecord } from "./core/runtime-types.js";
import {
  ConversationRuntime,
  isInputAuthorized,
  reconstructPendingJobs,
} from "./runtime.js";

const temporaryPaths: string[] = [];

function conversationAt(root: string): ResolvedConversation {
  const accountDir = join(root, "account");
  const conversationDir = join(accountDir, "channel");
  const workspaceDir = join(conversationDir, "workspace");
  return {
    service: "discord",
    botName: "pi",
    accountId: "account",
    account: {
      service: "discord",
      botToken: "token",
      applicationId: "app",
      serverId: "server",
      serverName: "server",
      channels: {},
    },
    channelKey: "channel",
    channel: {
      id: "channel",
      name: "channel",
      access: { allowedUserIds: ["owner"] },
    },
    conversationId: "account/channel",
    conversationName: "account / channel",
    access: { ignoreBots: true, allowedUserIds: ["owner"] },
    gondolinSecrets: {},
    accountDir,
    sharedDir: join(accountDir, "shared"),
    conversationDir,
    workspaceDir,
    gondolinDir: join(conversationDir, "gondolin"),
    accountMemoryPath: join(accountDir, "shared", "memory.md"),
    channelMemoryPath: join(workspaceDir, "memory.md"),
    logPath: join(conversationDir, "channel.jsonl"),
    filesDir: join(workspaceDir, "incoming"),
    lockPath: join(conversationDir, ".lock"),
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("persisted job reconstruction", () => {
  it("keeps queue order, deduplicates ids, and excludes completed or failed jobs", () => {
    const queued = (recordId: number, jobId: string) =>
      ({
        type: "job_queued",
        recordId,
        jobId,
        trigger: "mention",
        triggerRecordId: recordId - 1,
      }) as ChatLogRecord;
    const records = [
      queued(20, "failed"),
      queued(10, "first"),
      queued(11, "first"),
      {
        type: "job_failed",
        recordId: 21,
        jobId: "failed",
        triggerRecordId: 19,
        error: "failed",
      } as ChatLogRecord,
      queued(30, "last"),
      {
        type: "job_completed",
        recordId: 31,
        jobId: "completed",
        triggerRecordId: 29,
      } as ChatLogRecord,
      queued(29, "completed"),
    ];
    expect(reconstructPendingJobs(records).map((job) => job.jobId)).toEqual([
      "first",
      "last",
    ]);
  });
});

describe("runtime recovery", () => {
  it("dispatches a persisted unmatched job exactly once after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-chat-runtime-"));
    temporaryPaths.push(root);
    const conversation = conversationAt(root);
    const first = await ConversationRuntime.connect(
      conversation,
      `pi-chat-${process.pid}-first`,
    );
    first.armAfterCurrentTail();
    await first.ingestInbound({
      userId: "owner",
      text: "@pi hello",
      mentionedBot: true,
    });
    await first.disconnect();

    const restarted = await ConversationRuntime.connect(
      conversation,
      `pi-chat-${process.pid}-second`,
    );
    const recovered = restarted.beginNextJob();
    expect(recovered?.prompt).toContain("hello");
    expect(restarted.beginNextJob()).toBeUndefined();
    await restarted.completeActiveJob("done");
    await restarted.disconnect();

    const final = await ConversationRuntime.connect(
      conversation,
      `pi-chat-${process.pid}-third`,
    );
    expect(final.beginNextJob()).toBeUndefined();
    await final.disconnect();
  });
});

describe("input authorization", () => {
  it("fails closed and accepts an explicitly allowed user or role", () => {
    expect(isInputAuthorized({}, { userId: "any" })).toBe(false);
    expect(
      isInputAuthorized({ allowedUserIds: ["owner"] }, { userId: "owner" }),
    ).toBe(true);
    expect(
      isInputAuthorized(
        { allowedRoleIds: ["admins"] },
        { userId: "other", roleIds: ["admins"] },
      ),
    ).toBe(true);
    expect(
      isInputAuthorized(
        { allowedUserIds: ["owner"], allowedRoleIds: ["admins"] },
        { userId: "other", roleIds: ["admins"] },
      ),
    ).toBe(true);
    expect(
      isInputAuthorized(
        { allowedUserIds: ["owner"] },
        { userId: "owner", isBot: true },
      ),
    ).toBe(false);
  });
});

describe("observation leases", () => {
  it("renews a scope for fifteen minutes and stops dispatching after expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T12:00:00Z"));
    const root = await mkdtemp(join(tmpdir(), "pi-chat-observe-"));
    temporaryPaths.push(root);
    const conversation = conversationAt(root);
    conversation.access.trigger = "observe";
    const runtime = await ConversationRuntime.connect(
      conversation,
      `pi-chat-${process.pid}-observe`,
    );
    runtime.armAfterCurrentTail();

    await runtime.ingestInbound({
      userId: "owner",
      text: "@pi follow this",
      mentionedBot: true,
      scopeId: "thread-a",
      scopeName: "rabbit-hole",
      scopeKind: "thread",
    });
    expect(runtime.beginNextJob()?.job.trigger).toBe("mention");
    await runtime.completeActiveJob("following");

    vi.advanceTimersByTime(14 * 60_000);
    await runtime.ingestInbound({
      userId: "owner",
      text: "one more thing",
      scopeId: "thread-a",
      scopeName: "rabbit-hole",
      scopeKind: "thread",
    });
    expect(runtime.beginNextJob()?.job.trigger).toBe("observe");
    await runtime.completeActiveJob("");
    expect(runtime.getObservedScopes()).toMatchObject([
      { id: "thread-a", name: "rabbit-hole", kind: "thread" },
    ]);

    vi.advanceTimersByTime(15 * 60_000 + 1);
    await runtime.ingestInbound({
      userId: "owner",
      text: "after expiry",
      scopeId: "thread-a",
      scopeName: "rabbit-hole",
      scopeKind: "thread",
    });
    expect(runtime.beginNextJob()).toBeUndefined();
    expect(runtime.getObservedScopes()).toEqual([]);
    await runtime.disconnect();
  });

  it("keeps concurrent channel and thread transcript boundaries independent", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-chat-scopes-"));
    temporaryPaths.push(root);
    const conversation = conversationAt(root);
    conversation.access.trigger = "observe";
    const runtime = await ConversationRuntime.connect(
      conversation,
      `pi-chat-${process.pid}-scopes`,
    );
    runtime.armAfterCurrentTail();

    await runtime.ingestInbound({
      userId: "owner",
      text: "@pi channel topic",
      mentionedBot: true,
      scopeId: "channel",
      scopeName: "middle-halls",
    });
    await runtime.ingestInbound({
      userId: "owner",
      text: "@pi thread topic",
      mentionedBot: true,
      scopeId: "thread",
      scopeName: "rabbit-hole",
      scopeKind: "thread",
    });
    const channelJob = runtime.beginNextJob();
    expect(channelJob?.prompt).toContain("channel topic");
    expect(channelJob?.prompt).not.toContain("thread topic");
    await runtime.completeActiveJob("channel reply");
    const threadJob = runtime.beginNextJob();
    expect(threadJob?.prompt).toContain("thread topic");
    expect(threadJob?.prompt).not.toContain("channel topic");
    await runtime.completeActiveJob("thread reply");
    await runtime.disconnect();
  });

  it("does not revive an expired lease from a delayed catch-up mention", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T12:30:00Z"));
    const root = await mkdtemp(join(tmpdir(), "pi-chat-stale-observe-"));
    temporaryPaths.push(root);
    const conversation = conversationAt(root);
    conversation.access.trigger = "observe";
    const runtime = await ConversationRuntime.connect(
      conversation,
      `pi-chat-${process.pid}-stale`,
    );
    runtime.armAfterCurrentTail();
    const result = await runtime.ingestInbound({
      userId: "owner",
      text: "@pi old mention",
      mentionedBot: true,
      sentAt: "2026-07-28T12:00:00Z",
      scopeId: "thread",
      scopeName: "old-thread",
      scopeKind: "thread",
    });
    expect(result.jobQueued).toBe(true);
    expect(runtime.getObservedScopes()).toEqual([]);
    await runtime.disconnect();
  });

  it("only accepts unmentioned control commands inside an active lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-chat-control-observe-"));
    temporaryPaths.push(root);
    const conversation = conversationAt(root);
    conversation.access.trigger = "observe";
    const runtime = await ConversationRuntime.connect(
      conversation,
      `pi-chat-${process.pid}-control`,
    );
    const status = { userId: "owner", text: "status", scopeId: "channel" };
    expect(runtime.canHandleControl(status)).toBe(false);
    await runtime.ingestInbound({ ...status, mentionedBot: true }, undefined, {
      queueJobs: false,
    });
    expect(runtime.canHandleControl(status)).toBe(true);
    await runtime.disconnect();

    const restarted = await ConversationRuntime.connect(
      conversation,
      `pi-chat-${process.pid}-control-restarted`,
    );
    expect(restarted.canHandleControl(status)).toBe(true);
    expect(restarted.beginNextJob()).toBeUndefined();
    await restarted.disconnect();
  });

  it("does not infer a lease from mentions recorded before observe mode was enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-chat-mode-switch-"));
    temporaryPaths.push(root);
    const conversation = conversationAt(root);
    const mentionRuntime = await ConversationRuntime.connect(
      conversation,
      `pi-chat-${process.pid}-mention-mode`,
    );
    mentionRuntime.armAfterCurrentTail();
    await mentionRuntime.ingestInbound({
      userId: "owner",
      text: "@pi hello",
      mentionedBot: true,
    });
    await mentionRuntime.disconnect();

    conversation.access.trigger = "observe";
    const observeRuntime = await ConversationRuntime.connect(
      conversation,
      `pi-chat-${process.pid}-observe-mode`,
    );
    expect(observeRuntime.getObservedScopes()).toEqual([]);
    await observeRuntime.disconnect();
  });
});
