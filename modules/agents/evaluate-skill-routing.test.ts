import assert from "node:assert/strict";
import { test } from "node:test";
import { score } from "./evaluate-skill-routing.ts";

const fixture = {
  id: "isolated", prompt: "Draft an essay.",
  expectedSkills: ["write"], forbiddenSkills: ["remember"],
};
const catalog = new Set(["write", "remember", "document"]);
const call = (name: unknown, tool = "skill") => ({
  type: "toolCall", name: tool, arguments: { name },
});

test("missing expected selection fails", () => {
  assert.equal(score(fixture, { content: [], stopReason: "stop" }, catalog).pass, false);
});
test("clarification text is preserved without passing required selection", () => {
  const result = score(fixture, {
    content: [
      { type: "text", text: "Please share the notes." },
      { type: "thinking", text: "Not assistant text." },
      { type: "text", text: "I need them before drafting." },
    ],
    stopReason: "stop",
  }, catalog);
  assert.equal(result.assistantText, "Please share the notes.\nI need them before drafting.");
  assert.equal(result.pass, false);
  assert.deepEqual(result.observed, []);
});
test("forbidden selection fails even with expected selection", () => {
  assert.equal(score(fixture, {
    content: [call("write"), call("remember")], stopReason: "toolUse",
  }, catalog).pass, false);
});
test("valid extra selection is reported without failing", () => {
  const result = score(fixture, {
    content: [call("write"), call("document")], stopReason: "toolUse",
  }, catalog);
  assert.equal(result.pass, true);
  assert.deepEqual(result.observed, ["write", "document"]);
  assert.deepEqual(result.unexpected, ["document"]);
});
test("unknown tool, hallucinated name, and malformed name cannot pass a negative case", () => {
  for (const invalid of [call("write", "exec"), call("imaginary"), call(42)]) {
    assert.equal(score({ ...fixture, expectedSkills: [] }, {
      content: [invalid], stopReason: "toolUse",
    }, catalog).pass, false);
  }
});
test("provider error fails even when expected selection exists", () => {
  const result = score(fixture, {
    content: [call("write")], stopReason: "error", errorMessage: "provider failed",
  }, catalog);
  assert.equal(result.pass, false);
  assert.equal(result.error, "provider failed");
});
test("no call passes when none is required", () => {
  const result = score({ ...fixture, expectedSkills: [] }, {
    content: [{ type: "text" }], stopReason: "stop",
  }, catalog);
  assert.equal(result.pass, true);
  assert.deepEqual(result.observed, []);
});

const lookup = {
  id: "known-file", prompt: "Read modules/agents/skills/write/SKILL.md and tell me its declared name.",
  expectedSkills: [], forbiddenSkills: ["write"],
};
const read = (args: Record<string, unknown>) => ({
  type: "toolCall", name: "read", arguments: args,
});
test("known-file lookup can select read without selecting a skill", () => {
  for (const args of [
    { path: "modules/agents/skills/write/SKILL.md" },
    { path: "/workspace/modules/agents/skills/write/SKILL.md", offset: 1, limit: 20 },
  ]) {
    const result = score(lookup, { content: [read(args)], stopReason: "toolUse" }, catalog);
    assert.equal(result.pass, true);
    assert.deepEqual(result.observed, []);
    assert.equal(result.calls[0].name, "read");
  }
});
test("read does not excuse a forbidden skill selection", () => {
  assert.equal(score(lookup, {
    content: [read({ path: "modules/agents/skills/write/SKILL.md" }), call("write")],
    stopReason: "toolUse",
  }, catalog).pass, false);
});
test("invalid read arguments fail selection validation", () => {
  for (const args of [
    {}, { path: "" }, { path: " " }, { path: 42 },
    { path: "file", offset: "1" }, { path: "file", limit: null },
    { path: "file", offset: Infinity }, { path: "file", limit: NaN },
  ]) {
    assert.equal(score(lookup, { content: [read(args)], stopReason: "toolUse" }, catalog).pass, false);
  }
});
