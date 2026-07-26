import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApplyPatchTool } from "@bds_pi/apply-patch";
import * as toolPolicy from "@bds_pi/tool-policy";
import { createUndoEditTool } from "./index";

let testRoot: string;

beforeEach(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-undo-e2e-"));
  (
    globalThis as typeof globalThis & {
      __PI_FILE_CHANGES_DIR__?: string;
    }
  ).__PI_FILE_CHANGES_DIR__ = path.join(testRoot, ".changes");
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (
    globalThis as typeof globalThis & {
      __PI_FILE_CHANGES_DIR__?: string;
    }
  ).__PI_FILE_CHANGES_DIR__;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

it("restores add, update, delete, and move from an apply_patch call", async () => {
  const sessionId = "session";
  const toolCallId = "patch-call";
  const added = path.join(testRoot, "added.txt");
  const updated = path.join(testRoot, "updated.txt");
  const deleted = path.join(testRoot, "deleted.sh");
  const moveSource = path.join(testRoot, "move-source.txt");
  const moveDestination = path.join(testRoot, "move-destination.txt");

  fs.writeFileSync(updated, "before\n");
  fs.writeFileSync(deleted, "#!/bin/sh\n");
  fs.chmodSync(deleted, 0o755);
  fs.writeFileSync(moveSource, "moved\n");
  fs.chmodSync(moveSource, 0o755);
  vi.spyOn(toolPolicy, "loadToolPolicy").mockReturnValue([]);
  vi.spyOn(toolPolicy, "evaluateToolPolicy").mockReturnValue({
    action: "allow",
  });
  const context = {
    cwd: testRoot,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: toolCallId }],
          },
        },
      ],
    },
  } as never;
  const patch = [
    "*** Begin Patch",
    "*** Add File: added.txt",
    "+added",
    "*** Update File: updated.txt",
    "@@",
    "-before",
    "+after",
    "*** Delete File: deleted.sh",
    "*** Update File: move-source.txt",
    "*** Move to: move-destination.txt",
    "*** End Patch",
  ].join("\n");

  await createApplyPatchTool().execute(
    toolCallId,
    { input: patch },
    undefined,
    undefined,
    context,
  );
  expect(fs.statSync(moveDestination).mode & 0o777).toBe(0o755);

  const tool = createUndoEditTool();
  for (const file of [added, updated, deleted, moveDestination, moveSource]) {
    const result = await tool.execute(
      `undo-${path.basename(file)}`,
      { path: file },
      undefined,
      undefined,
      context,
    );
    expect(result.content[0]).toMatchObject({ type: "text" });
  }

  expect(fs.existsSync(added)).toBe(false);
  expect(fs.readFileSync(updated, "utf8")).toBe("before\n");
  expect(fs.readFileSync(deleted, "utf8")).toBe("#!/bin/sh\n");
  expect(fs.statSync(deleted).mode & 0o777).toBe(0o755);
  expect(fs.readFileSync(moveSource, "utf8")).toBe("moved\n");
  expect(fs.existsSync(moveDestination)).toBe(false);
});
