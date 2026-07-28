import type { Message } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiscordAccountConfig, ResolvedConversation } from "../core/config-types.js";
import { buildDiscordInviteUrl } from "../services/discord.js";
import {
	MAX_DISCORD_ATTACHMENT_BYTES,
	MAX_DISCORD_ATTACHMENTS,
	messageToInput,
	readBoundedResponse,
	validateDiscordAttachmentMetadata,
} from "./discord.js";

const account: DiscordAccountConfig = {
	service: "discord",
	botToken: "token",
	applicationId: "app",
	serverId: "server",
	serverName: "server",
	botUserId: "bot",
	channels: {},
};

function conversation(access: ResolvedConversation["access"]): ResolvedConversation {
	return {
		service: "discord",
		account,
		access,
		channel: { id: "channel" },
	} as ResolvedConversation;
}

function message(userId: string, attachments: Array<{ url: string; size: number }> = []): Message {
	return {
		guildId: "server",
		channelId: "channel",
		id: "message",
		author: { id: userId, username: userId, bot: false },
		member: { displayName: userId, roles: { cache: { map: () => [] } } },
		attachments: new Map(
			attachments.map((attachment, index) => [String(index), { ...attachment, name: `file-${index}` }]),
		),
		content: "hello",
		mentions: { users: { has: () => false } },
	} as unknown as Message;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Discord inbound attachment policy", () => {
	it("authorizes the sender before fetching attachments", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const result = await messageToInput(
			conversation({ allowedUserIds: ["owner"] }),
			account,
			message("attacker", [{ url: "https://example.test/file", size: 1 }]),
		);
		expect(result).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("records an oversized attachment rejection without fetching or blocking the message", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const result = await messageToInput(
			conversation({ allowedUserIds: ["owner"] }),
			account,
			message("owner", [{ url: "https://example.test/file", size: MAX_DISCORD_ATTACHMENT_BYTES + 1 }]),
		);
		expect(result?.attachments).toEqual([]);
		expect(result?.text).toContain("attachments rejected");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects excessive count, per-file size, and aggregate size from metadata", () => {
		expect(() =>
			validateDiscordAttachmentMetadata(Array.from({ length: MAX_DISCORD_ATTACHMENTS + 1 }, () => ({ size: 1 }))),
		).toThrow("more than");
		expect(() => validateDiscordAttachmentMetadata([{ size: MAX_DISCORD_ATTACHMENT_BYTES + 1 }])).toThrow("per-file");
		expect(() => validateDiscordAttachmentMetadata([{ size: 13 * 1024 * 1024 }, { size: 13 * 1024 * 1024 }])).toThrow(
			"total",
		);
	});

	it("cancels a streamed response once it exceeds the byte bound", async () => {
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array([1, 2, 3]));
					controller.enqueue(new Uint8Array([4, 5, 6]));
					controller.close();
				},
			}),
		);
		await expect(readBoundedResponse(response, 5)).rejects.toThrow("allowed size");
	});
});

describe("Discord invite permissions", () => {
	it("requests only view, send, history, and attachment permissions", () => {
		expect(buildDiscordInviteUrl("app")).toContain("permissions=101376");
	});
});
