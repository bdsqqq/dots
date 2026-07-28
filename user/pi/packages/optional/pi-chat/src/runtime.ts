import { randomUUID } from "node:crypto";

import type {
	ChatLogRecord,
	CheckpointRecord,
	ConversationStatus,
	DispatchableJob,
	InboundMessageInput,
	InboundMessageRecord,
	JobQueuedRecord,
	ObservedScope,
	PendingJob,
	ResolvedConversation,
} from "../types.js";
import {
	acquireConversationLock,
	appendConversationRecord,
	buildBaseRecordFields,
	ensureConversationDirs,
	materializeAttachments,
	nextMessageId,
	normalizeInboundMessage,
	readConversationLog,
	releaseConversationLock,
} from "./log.js";

export function isInputAuthorized(
	access: ResolvedConversation["access"],
	message: Pick<InboundMessageInput, "userId" | "roleIds" | "isBot">,
): boolean {
	if ((message.isBot ?? false) && (access.ignoreBots ?? true)) return false;
	const allowedUsers = access.allowedUserIds ?? [];
	const allowedRoles = access.allowedRoleIds ?? [];
	if (allowedUsers.length === 0 && allowedRoles.length === 0) return false;
	if (allowedUsers.includes(message.userId)) return true;
	const roleIds = message.roleIds ?? [];
	return roleIds.some((roleId) => allowedRoles.includes(roleId));
}

export function reconstructPendingJobs(records: ChatLogRecord[]): PendingJob[] {
	const terminalJobIds = new Set(
		records
			.filter((record) => record.type === "job_completed" || record.type === "job_failed")
			.map((record) => record.jobId),
	);
	const seenJobIds = new Set<string>();
	const pending: PendingJob[] = [];
	for (const record of [...records].sort((a, b) => a.recordId - b.recordId)) {
		if (record.type !== "job_queued" || terminalJobIds.has(record.jobId) || seenJobIds.has(record.jobId)) continue;
		seenJobIds.add(record.jobId);
		const triggerRecord = records.find(
			(candidate) => candidate.type === "inbound" && candidate.recordId === record.triggerRecordId,
		) as InboundMessageRecord | undefined;
		pending.push({
			jobId: record.jobId,
			trigger: record.trigger,
			triggerRecordId: record.triggerRecordId,
			queuedRecordId: record.recordId,
			scopeId: record.scopeId ?? triggerRecord?.scopeId ?? triggerRecord?.channelId ?? "channel",
		});
	}
	return pending;
}

function isDMConversation(conversation: ResolvedConversation): boolean {
	return conversation.channel.dm ?? false;
}

function toGuestDisplayPath(conversation: ResolvedConversation, localPath: string): string {
	if (localPath === conversation.workspaceDir || localPath.startsWith(`${conversation.workspaceDir}/`)) {
		const suffix = localPath.slice(conversation.workspaceDir.length).replace(/^\//, "");
		return suffix ? `/workspace/${suffix}` : "/workspace";
	}
	if (localPath === conversation.sharedDir || localPath.startsWith(`${conversation.sharedDir}/`)) {
		const suffix = localPath.slice(conversation.sharedDir.length).replace(/^\//, "");
		return suffix ? `/shared/${suffix}` : "/shared";
	}
	return localPath;
}

function formatTranscriptRecord(conversation: ResolvedConversation, record: ChatLogRecord): string[] {
	if (record.type !== "inbound") return [];
	const scope =
		record.scopeKind === "thread"
			? ` [thread:${record.scopeName ?? record.scopeId ?? "unknown"}]`
			: record.scopeName
				? ` [channel:${record.scopeName}]`
				: "";
	const lines = [
		`- [${record.timestamp}]${scope} [uid:${record.userId}] ${record.userName ?? "unknown"}: ${record.text || "(no text)"}`,
	];
	if (record.attachments.length > 0) {
		lines.push("  attachments:");
		for (const attachment of record.attachments)
			lines.push(
				`  - ${toGuestDisplayPath(conversation, attachment.localPath)}${attachment.mimeType ? ` (${attachment.mimeType})` : ""}`,
			);
	}
	return lines;
}

function getLatestTriggerRecord(records: ChatLogRecord[], job: PendingJob): InboundMessageRecord | undefined {
	const triggerRecord = records.find((record) => record.recordId === job.triggerRecordId);
	if (!triggerRecord || triggerRecord.type !== "inbound") return undefined;
	return triggerRecord;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class ConversationRuntime {
	static readonly OBSERVATION_LEASE_MS = 15 * 60_000;

	readonly conversation: ResolvedConversation;
	private readonly ownerId: string;
	private records: ChatLogRecord[] = [];
	private nextRecordId = 1;
	private pendingJobs: PendingJob[] = [];
	private activeJob: PendingJob | undefined;
	private armedAfterRecordId: number | undefined;
	private readonly observedScopes = new Map<string, ObservedScope>();

	constructor(conversation: ResolvedConversation, ownerId: string) {
		this.conversation = conversation;
		this.ownerId = ownerId;
	}

	static async connect(conversation: ResolvedConversation, ownerId: string): Promise<ConversationRuntime> {
		const runtime = new ConversationRuntime(conversation, ownerId);
		await runtime.initialize();
		return runtime;
	}

	private async initialize(): Promise<void> {
		await ensureConversationDirs(this.conversation);
		await acquireConversationLock(this.conversation, this.ownerId);
		this.records = await readConversationLog(this.conversation);
		this.nextRecordId = this.records.reduce((max, record) => Math.max(max, record.recordId), 0) + 1;
		this.pendingJobs = reconstructPendingJobs(this.records);
		this.reconstructObservedScopes();
	}

	private reconstructObservedScopes(): void {
		if (this.conversation.access.trigger !== "observe") return;
		for (const record of this.records) {
			if (record.type !== "inbound" || !record.observationLease || !this.isAuthorizedInput(record)) continue;
			const scope = this.scopeFor(record);
			const timestamp = Date.parse(record.timestamp);
			if (!Number.isFinite(timestamp)) continue;
			this.observedScopes.set(scope.id, {
				...scope,
				expiresAt: timestamp + ConversationRuntime.OBSERVATION_LEASE_MS,
			});
		}
		this.pruneObservedScopes();
	}

	armAfterCurrentTail(): void {
		this.armedAfterRecordId = this.records.at(-1)?.recordId ?? 0;
	}

	isArmed(): boolean {
		return this.armedAfterRecordId !== undefined;
	}

	async disconnect(): Promise<void> {
		await releaseConversationLock(this.conversation);
	}

	private async appendRecord(record: ChatLogRecord): Promise<void> {
		this.records.push(record);
		this.nextRecordId = Math.max(this.nextRecordId, record.recordId + 1);
		await appendConversationRecord(this.conversation, record);
	}

	private scopeFor(
		message: Pick<InboundMessageInput, "scopeId" | "scopeName" | "scopeKind">,
	): Omit<ObservedScope, "expiresAt"> {
		return {
			id: message.scopeId || this.conversation.channel.id,
			name: message.scopeName || this.conversation.channel.name || this.conversation.channelKey,
			kind: message.scopeKind || "channel",
		};
	}

	private pruneObservedScopes(now = Date.now()): void {
		for (const [scopeId, scope] of this.observedScopes) {
			if (scope.expiresAt <= now) this.observedScopes.delete(scopeId);
		}
	}

	getObservedScopes(now = Date.now()): ObservedScope[] {
		this.pruneObservedScopes(now);
		return [...this.observedScopes.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	renewObservation(
		message: Pick<
			InboundMessageInput,
			"userId" | "roleIds" | "isBot" | "mentionedBot" | "scopeId" | "scopeName" | "scopeKind"
		>,
		now = Date.now(),
	): boolean {
		if (this.conversation.access.trigger !== "observe" || !this.isAuthorizedInput(message)) return false;
		const scope = this.scopeFor(message);
		const active = (this.observedScopes.get(scope.id)?.expiresAt ?? 0) > now;
		if (!message.mentionedBot && !active) return false;
		this.observedScopes.set(scope.id, {
			...scope,
			expiresAt: now + ConversationRuntime.OBSERVATION_LEASE_MS,
		});
		return true;
	}

	canHandleControl(input: InboundMessageInput): boolean {
		if (!this.isAuthorizedInput(input)) return false;
		if (isDMConversation(this.conversation) || this.conversation.access.trigger === "message") return true;
		if (input.mentionedBot) return true;
		if (this.conversation.access.trigger !== "observe") return false;
		return (this.observedScopes.get(this.scopeFor(input).id)?.expiresAt ?? 0) > Date.now();
	}

	private getLastQueuedTriggerRecordId(scopeId: string): number {
		let last = 0;
		for (const record of this.records) {
			if (record.type !== "job_queued") continue;
			const recordScopeId =
				record.scopeId ??
				(
					this.records.find(
						(candidate) => candidate.type === "inbound" && candidate.recordId === record.triggerRecordId,
					) as InboundMessageRecord | undefined
				)?.scopeId ??
				this.conversation.channel.id;
			if (recordScopeId === scopeId) last = Math.max(last, record.triggerRecordId);
		}
		return last;
	}

	private getLastCompletedTriggerRecordId(scopeId: string): number {
		let last = 0;
		for (const record of this.records) {
			if (record.type !== "job_completed") continue;
			const queued = this.records.find(
				(candidate) => candidate.type === "job_queued" && candidate.jobId === record.jobId,
			) as JobQueuedRecord | undefined;
			const recordScopeId =
				queued?.scopeId ??
				(
					this.records.find(
						(candidate) => candidate.type === "inbound" && candidate.recordId === record.triggerRecordId,
					) as InboundMessageRecord | undefined
				)?.scopeId ??
				this.conversation.channel.id;
			if (recordScopeId !== scopeId) continue;
			last = Math.max(last, record.triggerRecordId);
		}
		return last;
	}

	isAuthorizedInput(message: Pick<InboundMessageInput, "userId" | "roleIds" | "isBot">): boolean {
		return isInputAuthorized(this.conversation.access, message);
	}

	parseControlCommand(input: InboundMessageInput): "stop" | "new" | "compact" | "status" | undefined {
		const normalized = normalizeInboundMessage(input, this.conversation.botName);
		if (!this.isAuthorizedInput(normalized)) return undefined;
		const account = this.conversation.account;
		let text = normalized.text;
		const botUserId = "botUserId" in account ? account.botUserId : undefined;
		if (botUserId) text = text.replace(new RegExp(`<@!?${escapeRegExp(botUserId)}>`, "g"), " ");
		const aliases = [this.conversation.botName, "botUsername" in account ? account.botUsername : undefined].filter(
			Boolean,
		);
		for (const alias of aliases) text = text.replace(new RegExp(`@${escapeRegExp(alias || "")}\\b`, "ig"), " ");
		const command = text.replace(/\s+/g, " ").trim().toLowerCase();
		if (command === "stop" || command === "/stop") return "stop";
		if (command === "new" || command === "/new") return "new";
		if (command === "compact" || command === "/compact") return "compact";
		if (command === "status" || command === "/status") return "status";
		return undefined;
	}

	matchesStopCommand(input: InboundMessageInput): boolean {
		return this.parseControlCommand(input) === "stop";
	}

	private shouldTriggerJob(message: InboundMessageRecord): false | "mention" | "observe" | "dm" {
		if (!this.isAuthorizedInput(message)) return false;
		if (isDMConversation(this.conversation)) return "dm";
		const trigger = this.conversation.access.trigger ?? "mention";
		if (trigger === "message") return "mention";
		if (trigger === "observe") {
			const sentAt = Date.parse(message.timestamp);
			if (!this.renewObservation(message, Number.isFinite(sentAt) ? sentAt : Date.now())) return false;
			return message.mentionedBot ? "mention" : "observe";
		}
		return message.mentionedBot ? "mention" : false;
	}

	private shouldQueueTrigger(recordId: number, scopeId: string): boolean {
		if (this.armedAfterRecordId === undefined) return false;
		return recordId > Math.max(this.armedAfterRecordId, this.getLastQueuedTriggerRecordId(scopeId));
	}

	getLastCheckpoint(): { cursor?: string; messageId?: string } {
		for (let index = this.records.length - 1; index >= 0; index--) {
			const record = this.records[index];
			if (record?.type === "checkpoint") return { cursor: record.cursor, messageId: record.messageId };
		}
		return {};
	}

	async noteCheckpoint(checkpoint: { cursor?: string; messageId?: string }): Promise<void> {
		const previous = this.getLastCheckpoint();
		if (previous.cursor === checkpoint.cursor && previous.messageId === checkpoint.messageId) return;
		const record: CheckpointRecord = {
			type: "checkpoint",
			...buildBaseRecordFields(this.conversation, this.nextRecordId),
			cursor: checkpoint.cursor,
			messageId: checkpoint.messageId,
		};
		await this.appendRecord(record);
	}

	async ingestInbound(
		input: InboundMessageInput,
		checkpoint?: { cursor?: string; messageId?: string },
		options: { queueJobs?: boolean } = {},
	): Promise<{ record: InboundMessageRecord; jobQueued: boolean }> {
		const normalized = normalizeInboundMessage(input, this.conversation.botName);
		const messageId = normalized.messageId || nextMessageId(this.conversation.service);
		const attachments = await materializeAttachments(this.conversation, messageId, normalized.attachments);
		const record: InboundMessageRecord = {
			type: "inbound",
			...buildBaseRecordFields(this.conversation, this.nextRecordId),
			...(normalized.sentAt && Number.isFinite(Date.parse(normalized.sentAt))
				? { timestamp: new Date(normalized.sentAt).toISOString() }
				: {}),
			messageId,
			userId: normalized.userId,
			userName: normalized.userName,
			roleIds: normalized.roleIds,
			text: normalized.text,
			mentionedBot: normalized.mentionedBot ?? false,
			isBot: normalized.isBot ?? false,
			scopeId: normalized.scopeId,
			scopeName: normalized.scopeName,
			scopeKind: normalized.scopeKind,
			attachments,
		};
		const trigger = this.shouldTriggerJob(record);
		if (this.conversation.access.trigger === "observe" && (trigger === "mention" || trigger === "observe")) {
			record.observationLease = true;
		}
		await this.appendRecord(record);
		const scopeId = this.scopeFor(record).id;
		if (!trigger || options.queueJobs === false || !this.shouldQueueTrigger(record.recordId, scopeId)) {
			if (checkpoint) await this.noteCheckpoint(checkpoint);
			return { record, jobQueued: false };
		}
		const queuedRecord: JobQueuedRecord = {
			type: "job_queued",
			...buildBaseRecordFields(this.conversation, this.nextRecordId),
			jobId: randomUUID(),
			trigger,
			triggerRecordId: record.recordId,
			scopeId,
		};
		await this.appendRecord(queuedRecord);
		this.pendingJobs.push({
			jobId: queuedRecord.jobId,
			trigger: queuedRecord.trigger,
			triggerRecordId: queuedRecord.triggerRecordId,
			queuedRecordId: queuedRecord.recordId,
			scopeId,
		});
		if (checkpoint) await this.noteCheckpoint(checkpoint);
		return { record, jobQueued: true };
	}

	beginNextJob(): DispatchableJob | undefined {
		if (this.activeJob || this.pendingJobs.length === 0) return undefined;
		const job = this.pendingJobs.shift();
		if (!job) return undefined;
		this.activeJob = job;
		const triggerRecord = getLatestTriggerRecord(this.records, job);
		return {
			job,
			prompt: this.buildPrompt(job),
			triggerMessageId: triggerRecord?.messageId,
			triggerScopeId: job.scopeId,
		};
	}

	private buildPrompt(job: PendingJob): string {
		const completedBoundary = this.getLastCompletedTriggerRecordId(job.scopeId);
		const slice = this.records
			.filter(
				(record) =>
					record.recordId > completedBoundary && record.recordId <= job.triggerRecordId && record.type === "inbound",
			)
			.filter((record) => this.scopeFor(record as InboundMessageRecord).id === job.scopeId);
		const lines: string[] = [];
		for (const record of slice) lines.push(...formatTranscriptRecord(this.conversation, record));
		return lines.join("\n").trim();
	}

	async completeActiveJob(text: string, remoteMessageId?: string, attachmentPaths?: string[]): Promise<void> {
		const job = this.activeJob;
		if (!job) return;
		let outboundRecordId: number | undefined;
		const trimmed = text.trim();
		if (trimmed.length > 0 || (attachmentPaths?.length ?? 0) > 0) {
			const triggerRecord = getLatestTriggerRecord(this.records, job);
			const outbound = {
				type: "outbound",
				...buildBaseRecordFields(this.conversation, this.nextRecordId),
				messageId: remoteMessageId || nextMessageId(this.conversation.service),
				text: trimmed,
				replyToMessageId: triggerRecord?.messageId,
				jobId: job.jobId,
				attachments: attachmentPaths?.length ? [...attachmentPaths] : undefined,
			} as const;
			outboundRecordId = outbound.recordId;
			await this.appendRecord(outbound);
		}
		await this.appendRecord({
			type: "job_completed",
			...buildBaseRecordFields(this.conversation, this.nextRecordId),
			jobId: job.jobId,
			triggerRecordId: job.triggerRecordId,
			outboundRecordId,
		});
		this.activeJob = undefined;
	}

	async failActiveJob(error: string): Promise<void> {
		const job = this.activeJob;
		if (!job) return;
		await this.appendRecord({
			type: "job_failed",
			...buildBaseRecordFields(this.conversation, this.nextRecordId),
			jobId: job.jobId,
			triggerRecordId: job.triggerRecordId,
			error,
		});
		this.activeJob = undefined;
	}

	async appendError(message: string): Promise<void> {
		await this.appendRecord({
			type: "error",
			...buildBaseRecordFields(this.conversation, this.nextRecordId),
			message,
		});
	}

	findHistory(options: { query?: string; after?: string; before?: string; limit?: number }): Array<ChatLogRecord> {
		const query = options.query?.toLowerCase();
		const after = options.after ? Date.parse(options.after) : undefined;
		const before = options.before ? Date.parse(options.before) : undefined;
		const limit = Math.max(1, Math.min(options.limit ?? 20, 200));
		const filtered = this.records.filter((record) => {
			if (record.type !== "inbound" && record.type !== "outbound") return false;
			const ts = Date.parse(record.timestamp);
			if (after !== undefined && !(ts >= after)) return false;
			if (before !== undefined && !(ts <= before)) return false;
			if (!query) return true;
			const speaker = record.type === "inbound" ? (record.userName ?? record.userId) : "assistant";
			return `${speaker}\n${record.text}`.toLowerCase().includes(query);
		});
		return filtered.slice(Math.max(0, filtered.length - limit));
	}

	getStatus(): ConversationStatus {
		return {
			conversationId: this.conversation.conversationId,
			conversationName: this.conversation.conversationName,
			logPath: this.conversation.logPath,
			queueLength: this.pendingJobs.length,
			hasActiveJob: this.activeJob !== undefined,
			recordCount: this.records.length,
			lastRecordId: this.records.at(-1)?.recordId ?? 0,
		};
	}
}
