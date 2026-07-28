import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedConversation } from "./core/config-types.js";
import type { ChatLogRecord } from "./core/runtime-types.js";
import { ConversationRuntime, isInputAuthorized, reconstructPendingJobs } from "./runtime.js";

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
		channel: { id: "channel", name: "channel", access: { allowedUserIds: ["owner"] } },
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
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("persisted job reconstruction", () => {
	it("keeps queue order, deduplicates ids, and excludes completed or failed jobs", () => {
		const queued = (recordId: number, jobId: string) =>
			({ type: "job_queued", recordId, jobId, trigger: "mention", triggerRecordId: recordId - 1 }) as ChatLogRecord;
		const records = [
			queued(20, "failed"),
			queued(10, "first"),
			queued(11, "first"),
			{ type: "job_failed", recordId: 21, jobId: "failed", triggerRecordId: 19, error: "failed" } as ChatLogRecord,
			queued(30, "last"),
			{ type: "job_completed", recordId: 31, jobId: "completed", triggerRecordId: 29 } as ChatLogRecord,
			queued(29, "completed"),
		];
		expect(reconstructPendingJobs(records).map((job) => job.jobId)).toEqual(["first", "last"]);
	});
});

describe("runtime recovery", () => {
	it("dispatches a persisted unmatched job exactly once after restart", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-chat-runtime-"));
		temporaryPaths.push(root);
		const conversation = conversationAt(root);
		const first = await ConversationRuntime.connect(conversation, `pi-chat-${process.pid}-first`);
		first.armAfterCurrentTail();
		await first.ingestInbound({ userId: "owner", text: "@pi hello", mentionedBot: true });
		await first.disconnect();

		const restarted = await ConversationRuntime.connect(conversation, `pi-chat-${process.pid}-second`);
		const recovered = restarted.beginNextJob();
		expect(recovered?.prompt).toContain("hello");
		expect(restarted.beginNextJob()).toBeUndefined();
		await restarted.completeActiveJob("done");
		await restarted.disconnect();

		const final = await ConversationRuntime.connect(conversation, `pi-chat-${process.pid}-third`);
		expect(final.beginNextJob()).toBeUndefined();
		await final.disconnect();
	});
});

describe("input authorization", () => {
	it("fails closed and accepts an explicitly allowed user or role", () => {
		expect(isInputAuthorized({}, { userId: "any" })).toBe(false);
		expect(isInputAuthorized({ allowedUserIds: ["owner"] }, { userId: "owner" })).toBe(true);
		expect(isInputAuthorized({ allowedRoleIds: ["admins"] }, { userId: "other", roleIds: ["admins"] })).toBe(true);
		expect(
			isInputAuthorized(
				{ allowedUserIds: ["owner"], allowedRoleIds: ["admins"] },
				{ userId: "other", roleIds: ["admins"] },
			),
		).toBe(true);
		expect(isInputAuthorized({ allowedUserIds: ["owner"] }, { userId: "owner", isBot: true })).toBe(false);
	});
});
