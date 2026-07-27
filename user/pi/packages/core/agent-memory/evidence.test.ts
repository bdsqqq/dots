import { describe, expect, it } from "vitest";
import { buildSafeEvidence, redact, type BranchEntry } from "./evidence.js";

describe("safe trajectory evidence", () => {
  it("redacts secrets before preserving authored text", () => {
    const result = redact(
      "Bearer tiny Basic YQ== password is short " +
        "aws_secret_access_key: OnlyLettersCanStillBeAValidAwsSecretKeyHere " +
        '{"password":"json-tiny","aws_secret_access_key":"JsonLettersOnlySecret"} ' +
        '{"password":"abc\\"def"} PASSWORD="shell\\"secret" ' +
        "authorization: Bearer abcdefghijklmnopqrstuvwxyz and sk-abcdefghijklmnop " +
        "AKIAIOSFODNN7EXAMPLE 4f3d2a1b0c9e8d7f6a5b4c3d2e1f0a9b " +
        "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=",
    );
    expect(result.text).not.toContain("tiny");
    expect(result.text).not.toContain("YQ==");
    expect(result.text).not.toContain("short");
    expect(result.text).not.toContain(
      "OnlyLettersCanStillBeAValidAwsSecretKeyHere",
    );
    expect(result.text).not.toContain("json-tiny");
    expect(result.text).not.toContain("JsonLettersOnlySecret");
    expect(result.text).not.toContain('abc\\"def');
    expect(result.text).not.toContain('shell\\"secret');
    expect(result.text).not.toContain('def"}');
    expect(result.text).not.toContain('secret"');
    expect(result.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(result.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.text).not.toContain("4f3d2a1b0c9e8d7f6a5b4c3d2e1f0a9b");
    expect(result.text).not.toContain(
      "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=",
    );
    expect(
      Object.values(result.counts).reduce((sum, count) => sum + count, 0),
    ).toBeGreaterThan(0);
  });

  it("preserves bounded tool evidence while removing reasoning and credentials", () => {
    const entries: BranchEntry[] = [
      {
        type: "message",
        id: "u",
        parentId: null,
        message: { role: "user", content: "verify the build" },
      },
      {
        type: "message",
        id: "a",
        parentId: "u",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private reasoning" },
            {
              type: "toolCall",
              id: "call",
              name: "bash",
              arguments: {
                command: "nix build",
                password: "tool-secret",
                accessToken: "short-live-token",
              },
            },
          ],
        },
      },
      {
        type: "message",
        id: "t",
        parentId: "a",
        message: {
          role: "toolResult",
          toolCallId: "call",
          content:
            "build output password=output-secret OPENAI_API_KEY=short-live-secret",
          isError: false,
        },
      },
      {
        type: "message",
        id: "final",
        parentId: "t",
        message: { role: "assistant", content: "build passed" },
      },
    ];
    const evidence = buildSafeEvidence({
      sessionId: "session",
      workspace: "/tmp/project",
      entries,
      checkpointEntryIds: ["cp"],
      checkpointFrontiers: { cp: "final" },
      throughLeafId: "final",
      branchEntryIds: entries.map((entry) => entry.id),
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("private reasoning");
    expect(serialized).not.toMatch(
      /tool-secret|output-secret|short-live-token|short-live-secret/,
    );
    expect(serialized).toContain("nix build");
    expect(serialized).toContain("build output");
    expect(evidence.tools).toEqual([
      { name: "bash", calls: 1, successes: 1, errors: 0 },
    ]);
    expect(serialized).toContain("build passed");
  });
});
