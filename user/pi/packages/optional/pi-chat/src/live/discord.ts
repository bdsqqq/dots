// Discord live connection implemented with discord.js.

import { once } from "node:events";

import { Client, Events, GatewayIntentBits, type Message, Partials } from "discord.js";

import type { DiscordAccountConfig, ResolvedConversation } from "../core/config-types.js";
import type { InboundMessageInput } from "../core/runtime-types.js";
import { chunkText } from "../render/chunking.js";
import { formatMarkdownForService, maxMessageLength } from "../render/format.js";
import { StreamingPreview } from "../render/streaming.js";
import { isInputAuthorized } from "../runtime.js";
import { readLocalAttachment, storeDownloadedAttachment, textMentionsBot } from "./common.js";
import type { LiveConnection, LiveConnectionHandlers } from "./types.js";

async function withReadyClient(token: string): Promise<Client<true>> {
	const client = new Client({
		intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
		partials: [Partials.Channel],
	});
	const readyPromise = once(client, "ready");
	try {
		await client.login(token);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("Used disallowed intents")) {
			throw new Error(
				'Discord rejected the configured gateway intents. Enable the "Message Content Intent" in the Discord Developer Portal under Bot settings, then reconnect.',
			);
		}
		throw error;
	}
	if (!client.isReady()) {
		await Promise.race([
			readyPromise,
			new Promise((_, reject) => setTimeout(() => reject(new Error("Discord client failed to become ready")), 10000)),
		]);
	}
	if (!client.isReady()) throw new Error("Discord client failed to become ready");
	return client as Client<true>;
}

function getTargetChannelId(conversation: ResolvedConversation): string {
	return conversation.channel.id;
}

type DiscordTextChannel = {
	send(payload: unknown): Promise<{ id: string; edit(payload: unknown): Promise<unknown> }>;
	sendTyping(): Promise<void>;
	messages: { fetch(idOrOptions?: unknown): Promise<any> };
};

async function resolveTextChannel(
	client: Client<true>,
	conversation: ResolvedConversation,
): Promise<DiscordTextChannel> {
	const channelId = getTargetChannelId(conversation);
	const channel = await client.channels.fetch(channelId);
	if (!channel?.isTextBased()) throw new Error(`Discord channel is not text-based: ${channelId}`);
	return channel as unknown as DiscordTextChannel;
}

export const MAX_DISCORD_ATTACHMENTS = 10;
export const MAX_DISCORD_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_DISCORD_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function validateDiscordAttachmentMetadata(attachments: Array<{ size: number }>): void {
	if (attachments.length > MAX_DISCORD_ATTACHMENTS)
		throw new Error(`Discord message has more than ${MAX_DISCORD_ATTACHMENTS} attachments`);
	let total = 0;
	for (const attachment of attachments) {
		if (!Number.isSafeInteger(attachment.size) || attachment.size < 0)
			throw new Error("Discord attachment has an invalid size");
		if (attachment.size > MAX_DISCORD_ATTACHMENT_BYTES)
			throw new Error("Discord attachment exceeds the 25 MiB per-file limit");
		total += attachment.size;
		if (total > MAX_DISCORD_TOTAL_ATTACHMENT_BYTES)
			throw new Error("Discord attachments exceed the 25 MiB total limit");
	}
}

export async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes)
		throw new Error("Discord attachment response exceeds its allowed size");
	if (!response.body) throw new Error("Discord attachment response has no body");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) throw new Error("Discord attachment response exceeds its allowed size");
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

export async function messageToInput(
	conversation: ResolvedConversation,
	account: DiscordAccountConfig,
	message: Message,
): Promise<InboundMessageInput | undefined> {
	if (message.guildId !== account.serverId) return undefined;
	if (message.channelId !== getTargetChannelId(conversation)) return undefined;
	if (message.author.id === account.botUserId) return undefined;
	const identity = {
		userId: message.author.id,
		roleIds: message.member?.roles.cache.map((role) => role.id),
		isBot: message.author.bot,
	};
	if (!isInputAuthorized(conversation.access, identity)) return undefined;
	const remoteAttachments = [...message.attachments.values()];
	const downloaded: Array<{ attachment: (typeof remoteAttachments)[number]; data: Uint8Array; index: number }> = [];
	let attachmentRejection: string | undefined;
	try {
		validateDiscordAttachmentMetadata(remoteAttachments);
		let downloadedBytes = 0;
		for (const [index, attachment] of remoteAttachments.entries()) {
			const response = await fetch(attachment.url);
			if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
			const remainingBytes = MAX_DISCORD_TOTAL_ATTACHMENT_BYTES - downloadedBytes;
			const data = await readBoundedResponse(response, Math.min(MAX_DISCORD_ATTACHMENT_BYTES, remainingBytes));
			downloadedBytes += data.byteLength;
			downloaded.push({ attachment, data, index });
		}
	} catch (error) {
		attachmentRejection = error instanceof Error ? error.message : String(error);
		downloaded.length = 0;
	}
	const attachments: NonNullable<InboundMessageInput["attachments"]> = [];
	for (const { attachment, data, index } of downloaded) {
		attachments.push(
			await storeDownloadedAttachment(
				conversation,
				message.id,
				index + 1,
				attachment.name || `attachment-${index + 1}`,
				data,
				attachment.contentType || undefined,
				attachment.url,
			),
		);
	}
	return {
		messageId: message.id,
		userId: identity.userId,
		userName: message.member?.displayName || message.author.username,
		roleIds: identity.roleIds,
		text: [message.content || "", attachmentRejection ? `[attachments rejected: ${attachmentRejection}]` : ""]
			.filter(Boolean)
			.join("\n"),
		mentionedBot:
			message.mentions.users.has(account.botUserId || "") ||
			textMentionsBot(message.content || "", account.botUsername, account.botUserId),
		isBot: message.author.bot,
		attachments,
	};
}

async function postDiscordMessage(
	botToken: string,
	channelId: string,
	payload: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<string> {
	const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
		method: "POST",
		headers: { Authorization: `Bot ${botToken}`, "content-type": "application/json" },
		body: JSON.stringify(payload),
		signal,
	});
	const data = (await response.json()) as { id?: string; message?: string };
	if (!response.ok || !data.id) throw new Error(data.message || "Discord send failed");
	return data.id;
}

async function sendDiscordMessage(
	botToken: string,
	channelId: string,
	content: string,
	attachmentPaths: string[] = [],
	signal?: AbortSignal,
	replyToMessageId?: string,
): Promise<string> {
	const rendered = formatMarkdownForService("discord", content);
	const limit = maxMessageLength("discord");
	const chunks = chunkText(rendered.text, limit);
	let firstMessageId: string | undefined;
	for (let i = 0; i < chunks.length; i++) {
		const payload: Record<string, unknown> = { content: chunks[i] };
		if (i === 0 && replyToMessageId) payload.message_reference = { message_id: replyToMessageId };
		if (i === chunks.length - 1 && attachmentPaths.length > 0) {
			const form = new FormData();
			form.set("payload_json", JSON.stringify(payload));
			for (const [index, path] of attachmentPaths.entries()) {
				const file = await readLocalAttachment(path);
				form.set(`files[${index}]`, new Blob([Buffer.from(file.data)], { type: file.mimeType }), file.name);
			}
			const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
				method: "POST",
				headers: { Authorization: `Bot ${botToken}` },
				body: form,
				signal,
			});
			const data = (await response.json()) as { id?: string; message?: string };
			if (!response.ok || !data.id) throw new Error(data.message || "Discord send failed");
			firstMessageId ??= data.id;
		} else {
			const id = await postDiscordMessage(botToken, channelId, payload, signal);
			firstMessageId ??= id;
		}
	}
	return firstMessageId || "";
}

async function catchUpMessages(
	client: Client<true>,
	conversation: ResolvedConversation,
	afterId?: string,
): Promise<Message[]> {
	const channel = await resolveTextChannel(client, conversation);
	const allMessages: Message[] = [];
	let cursor = afterId;
	while (true) {
		const batch = await channel.messages.fetch(cursor ? { after: cursor, limit: 100 } : { limit: 25 });
		if (batch.size === 0) break;
		const sorted = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
		allMessages.push(...sorted);
		cursor = sorted[sorted.length - 1].id;
		if (batch.size < 100) break;
	}
	return allMessages;
}

export async function connectDiscordLive(
	conversation: ResolvedConversation,
	handlers: LiveConnectionHandlers,
	lastMessageId?: string,
): Promise<LiveConnection> {
	const account = conversation.account as DiscordAccountConfig;
	const client = await withReadyClient(account.botToken);
	const seenIds = new Set<string>();
	const seenOrder: string[] = [];
	const processMessage = async (message: Message): Promise<void> => {
		if (seenIds.has(message.id)) return;
		seenIds.add(message.id);
		seenOrder.push(message.id);
		if (seenOrder.length > 1000) {
			const oldest = seenOrder.shift();
			if (oldest) seenIds.delete(oldest);
		}
		const input = await messageToInput(conversation, account, message);
		if (!input) return;
		await handlers.onMessage(input, { messageId: input.messageId, cursor: input.messageId });
	};
	let initializing = true;
	let bufferedMessages: Message[] = [];
	let liveQueue = Promise.resolve();
	const onMessageCreate = (message: Message) => {
		if (initializing) {
			bufferedMessages.push(message);
			return;
		}
		liveQueue = liveQueue
			.then(() => processMessage(message))
			.catch(async (error) => {
				await handlers.onError(error instanceof Error ? error : new Error(String(error)));
			});
	};
	client.on(Events.MessageCreate, onMessageCreate);
	for (const message of await catchUpMessages(client, conversation, lastMessageId)) await processMessage(message);
	while (bufferedMessages.length > 0) {
		const batch = bufferedMessages;
		bufferedMessages = [];
		batch.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
		for (const message of batch) await processMessage(message);
	}
	initializing = false;
	await handlers.onCaughtUp();
	const preview = new StreamingPreview(conversation.service, {
		create: async (text, _parseMode, replyToMessageId) => {
			return sendDiscordMessage(account.botToken, conversation.channel.id, text, [], undefined, replyToMessageId);
		},
		edit: async (id, text) => {
			const channel = await resolveTextChannel(client, conversation);
			const message = await channel.messages.fetch(id);
			await message.edit({ content: text });
		},
		delete: async (id) => {
			const channel = await resolveTextChannel(client, conversation);
			const message = await channel.messages.fetch(id);
			await message.delete();
		},
	});
	let disconnectFired = false;
	const fireDisconnect = () => {
		if (disconnectFired) return;
		disconnectFired = true;
		void handlers.onDisconnect?.();
	};
	client.on(Events.Error, (error) => {
		void handlers.onError(error instanceof Error ? error : new Error(String(error)));
	});
	client.on(Events.Invalidated, () => fireDisconnect());
	client.on("disconnect", () => fireDisconnect());
	client.ws.on("close" as any, () => {
		setTimeout(() => {
			if (!client.isReady()) fireDisconnect();
		}, 30000);
	});

	return {
		conversation,
		disconnect: async () => {
			client.off(Events.MessageCreate, onMessageCreate);
			client.destroy();
		},
		sendImmediate: async (text, replyToMessageId) => {
			return sendDiscordMessage(account.botToken, conversation.channel.id, text, [], undefined, replyToMessageId);
		},
		send: async (text, attachmentPaths = [], signal, replyToMessageId) =>
			sendDiscordMessage(account.botToken, conversation.channel.id, text, attachmentPaths, signal, replyToMessageId),
		startTyping: async () => {
			const channel = await resolveTextChannel(client, conversation);
			await channel.sendTyping();
		},
		stopTyping: async () => {},
		syncPreview: async (markdown, done = false) => preview.update(markdown, done),
		clearPreview: async () => preview.clear(),
		setReplyTo: (messageId) => preview.setReplyTo(messageId),
	};
}
