import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReadonlyProvider, RealFSProvider } from "@earendil-works/gondolin";
import { afterEach, describe, expect, it } from "vitest";

import {
	GONDOLIN_COMMONPLACE,
	GONDOLIN_SHARED,
	GONDOLIN_WORKSPACE,
	guestMountRoot,
	isAttachableGuestPath,
	resolveCommonplaceRoot,
} from "./gondolin.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryPaths.splice(0).map((temporaryPath) => rm(temporaryPath, { recursive: true, force: true })),
	);
});

describe("commonplace mount paths", () => {
	it("classifies all mounted roots without accepting lookalikes", () => {
		expect(guestMountRoot("/workspace/a")).toBe(GONDOLIN_WORKSPACE);
		expect(guestMountRoot("/shared/a")).toBe(GONDOLIN_SHARED);
		expect(guestMountRoot("/commonplace/a")).toBe(GONDOLIN_COMMONPLACE);
		expect(guestMountRoot("/commonplace-other/a")).toBeUndefined();
	});

	it("keeps attachment staging restricted to writable chat mounts", () => {
		expect(isAttachableGuestPath("/workspace/output.txt")).toBe(true);
		expect(isAttachableGuestPath("/shared/output.txt")).toBe(true);
		expect(isAttachableGuestPath("/commonplace/private.txt")).toBe(false);
	});

	it("rejects writes through the commonplace provider with EROFS", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-chat-readonly-"));
		temporaryPaths.push(root);
		const provider = new ReadonlyProvider(new RealFSProvider(root));
		await expect(provider.open("/file", "w")).rejects.toMatchObject({ errno: 30 });
		await provider.close();
	});

	it("requires an absolute existing directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-chat-commonplace-"));
		temporaryPaths.push(root);
		expect(resolveCommonplaceRoot(root)).toBe(await realpath(root));
		expect(() => resolveCommonplaceRoot(undefined)).toThrow("required");
		expect(() => resolveCommonplaceRoot("relative")).toThrow("absolute");
		const file = join(root, "file");
		await writeFile(file, "x");
		expect(() => resolveCommonplaceRoot(file)).toThrow("directory");
	});
});
