import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
	ChatTurnSettler,
	explicitExtensionCommandParts,
	piExecutable,
	tmuxSafeName,
	tryDecryptAuthorizedSecret,
	validSecretName,
	workerShellPrefix,
} from "./index.js";
import { createSecretRequest, hasPendingSecretRequest } from "./src/secrets.js";

describe("detached worker command", () => {
	it("uses PI_BIN when configured", () => {
		expect(piExecutable({ PI_BIN: "/custom/pi" } as NodeJS.ProcessEnv)).toBe("/custom/pi");
		expect(piExecutable({} as NodeJS.ProcessEnv)).toBe("pi");
	});

	it("preserves extension isolation and explicit extension paths", () => {
		expect(
			explicitExtensionCommandParts([
				"pi",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-context-files",
				"-e",
				"/tmp/chat.ts",
			]),
		).toEqual([
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"-e",
			"'/tmp/chat.ts'",
		]);
	});

	it("pins the worker environment and restrictive umask", () => {
		expect(
			workerShellPrefix({
				HOME: "/home/test",
				PATH: "/bin",
				PI_BIN: "/custom/pi",
				PI_CHAT_COMMONPLACE_ROOT: "/commonplace",
			} as NodeJS.ProcessEnv),
		).toEqual([
			"umask 077;",
			"exec env -i",
			"HOME='/home/test'",
			"PATH='/bin'",
			"PI_BIN='/custom/pi'",
			"PI_CHAT_COMMONPLACE_ROOT='/commonplace'",
			"'/custom/pi'",
		]);
	});
});

describe("secret names", () => {
	it("accepts safe basenames and rejects path traversal", () => {
		expect(validSecretName("github-token")).toBe(true);
		expect(validSecretName("../../shared/token")).toBe(false);
		expect(validSecretName("..")).toBe(false);
	});
});

describe("worker identity", () => {
	it("adds a stable hash so sanitized and truncated ids cannot collide", () => {
		const sharedPrefix = "account/" + "x".repeat(200);
		const first = tmuxSafeName(`${sharedPrefix}:one`);
		const second = tmuxSafeName(`${sharedPrefix}?one`);
		expect(first).not.toBe(second);
		expect(first).toMatch(/^pi-chat-worker-account_/);
		expect(first.length).toBeLessThanOrEqual(100);
	});
});

describe("agent settlement", () => {
	it("keeps an intermediate retry failure from finalizing over the successful retry", () => {
		const settler = new ChatTurnSettler();
		settler.noteAgentEnd([{ role: "assistant", stopReason: "error", errorMessage: "retry me", content: [] }]);
		settler.noteAgentEnd([{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "final" }] }]);
		expect(settler.take()).toEqual({ text: "final", stopReason: "stop", errorMessage: undefined });
		expect(settler.take()).toEqual({});
	});

	it("preserves ordinary final output and an unretried final error", () => {
		const success = new ChatTurnSettler();
		success.noteAgentEnd([{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "reply" }] }]);
		expect(success.take()).toMatchObject({ text: "reply", stopReason: "stop" });

		const failure = new ChatTurnSettler();
		failure.noteAgentEnd([{ role: "assistant", stopReason: "length", errorMessage: "too long", content: [] }]);
		expect(failure.take()).toMatchObject({ stopReason: "length", errorMessage: "too long" });
	});

	it("preserves a final abort for control-command handling", () => {
		const settler = new ChatTurnSettler();
		settler.noteAgentEnd([{ role: "assistant", stopReason: "aborted", content: [] }]);
		expect(settler.take().stopReason).toBe("aborted");
	});
});

describe("secret authorization", () => {
	it("does not consume a pending secret request for an unauthorized sender", () => {
		const { requestId, widgetUrl } = createSecretRequest("token", "test");
		const encoded = widgetUrl.slice(widgetUrl.indexOf("#") + 1);
		const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as { k: string };
		const aesKey = randomBytes(32);
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
		const ciphertext = Buffer.concat([cipher.update("secret"), cipher.final()]);
		const encryptedKey = publicEncrypt(
			{
				key: createPublicKey({
					key: Buffer.from(payload.k, "base64"),
					format: "der",
					type: "spki",
				}),
				padding: constants.RSA_PKCS1_OAEP_PADDING,
				oaepHash: "sha256",
			},
			aesKey,
		);
		const keyLength = Buffer.alloc(2);
		keyLength.writeUInt16BE(encryptedKey.length);
		const blob = Buffer.concat([keyLength, encryptedKey, iv, ciphertext, cipher.getAuthTag()]).toString("base64");
		const input = { userId: "attacker", text: `!secret:${requestId}:${blob}` };

		expect(tryDecryptAuthorizedSecret({ isAuthorizedInput: () => false }, input)).toBeUndefined();
		expect(hasPendingSecretRequest(requestId)).toBe(true);
		expect(tryDecryptAuthorizedSecret({ isAuthorizedInput: () => true }, input)?.decrypted).toBe("secret");
		expect(hasPendingSecretRequest(requestId)).toBe(false);
	});
});
