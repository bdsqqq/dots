import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Tool } from "../pi/node_modules/@earendil-works/pi-ai";

interface Fixture {
  id: string;
  prompt: string;
  expectedSkills: string[];
  forbiddenSkills: string[];
}
interface SelectionResult {
  content: { type: string; text?: string; name?: string; arguments?: Record<string, unknown> }[];
  stopReason: string;
  errorMessage?: string;
  usage?: unknown;
}

// Selection only: complete() returns tool calls; no agent loop or executor exists.
export function score(fixture: Fixture, result: SelectionResult, catalog: ReadonlySet<string>) {
  const calls = result.content.filter((part) => part.type === "toolCall");
  const observed = calls.filter((part) => part.name === "skill")
    .map((part) => part.arguments?.name);
  const expected = fixture.expectedSkills;
  const forbidden = fixture.forbiddenSkills;
  const malformed = calls.some((part) => {
    const args = part.arguments;
    if (part.name === "read") {
      // Native read uses optional numbers, not an integer/minimum schema.
      return typeof args?.path !== "string" || !args.path.trim() ||
        [args.offset, args.limit].some((value) =>
          value !== undefined && (typeof value !== "number" || !Number.isFinite(value)));
    }
    return part.name !== "skill" || typeof args?.name !== "string" || !catalog.has(args.name);
  });
  const names = observed.filter((name): name is string => typeof name === "string");
  return {
    id: fixture.id, observed, expected, forbidden, calls,
    assistantText: result.content.filter((part) => part.type === "text")
      .map((part) => part.text ?? "").join("\n"),
    unexpected: names.filter((name) => !expected.includes(name) && !forbidden.includes(name)),
    pass: ["stop", "toolUse"].includes(result.stopReason) && !malformed &&
      expected.every((name) => observed.includes(name)) &&
      forbidden.every((name) => !observed.includes(name)),
    stopReason: result.stopReason, error: result.errorMessage, usage: result.usage,
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    live: { type: "boolean" }, limit: { type: "string" }, case: { type: "string" },
  } });
  assert(values.live, "explicit --live required; uses existing Codex OAuth");
  assert(!(values.case !== undefined && values.limit !== undefined), "--case and --limit are mutually exclusive");
  const limit = Number(values.limit ?? "12");
  assert(Number.isInteger(limit) && limit >= 1 && limit <= 12, "--limit must be 1–12");
  const { checkSkills } = createRequire(import.meta.url)("./check-skills.ts") as
    import("./check-skills.ts").Checker;
  const { skills, errors } = await checkSkills();
  assert.deepEqual(errors, [], "native skill discovery must pass");
  const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
  const sources = skills.map((skill) => ({
    name: skill.name, description: skill.description,
    sha256: sha256(readFileSync(skill.filePath)),
  })).sort((a, b) => a.name.localeCompare(b.name));
  const fixturesText = readFileSync(new URL("./skill-cases.json", import.meta.url), "utf8");
  const allFixtures: Fixture[] = JSON.parse(fixturesText);
  const fixtures = values.case === undefined ? allFixtures.slice(0, limit) :
    allFixtures.filter((fixture) => fixture.id === values.case);
  assert(fixtures.length > 0 && (values.case === undefined || fixtures.length === 1),
    "--case must identify exactly one fixture");
  const catalog = new Set(sources.map(({ name }) => name));
  const globalText = readFileSync(new URL("../../config/global-agents.md", import.meta.url), "utf8");
  const systemPrompt = [
    globalText,
    "Choose relevant specialized workflows before proceeding with the user's request.",
    "Available skills (name and description):",
    JSON.stringify(sources.map(({ name, description }) => ({ name, description }))),
  ].join("\n\n");
  // Match check-skills' import-only SDK resolution, anchored to modules/pi.
  const require = createRequire(new URL("../pi/package.json", import.meta.url));
  const sdkName = "@earendil-works/pi-coding-agent";
  const manifest = require.resolve.paths(sdkName)
    ?.map((path) => join(path, sdkName, "package.json")).find(existsSync);
  assert(manifest, "pi SDK unavailable; install modules/pi dependencies first");
  const entry = JSON.parse(readFileSync(manifest, "utf8")).exports["."].import;
  const { ModelRuntime, createReadTool } = await import(pathToFileURL(resolve(dirname(manifest), entry)).href) as
    typeof import("../pi/node_modules/@earendil-works/pi-coding-agent");
  const total = AbortSignal.timeout((fixtures.length + 1) * 60000);
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, signal: total });
  const model = runtime.getModel("openai-codex", "gpt-6-astra");
  assert(model, "openai-codex/gpt-6-astra unavailable");
  assert.equal(model?.api, "openai-codex-responses");
  assert.equal(new URL(model.baseUrl).hostname, "chatgpt.com");
  // Constructing the native tool only creates closures; retain no executor.
  const { name, description, parameters } = createReadTool(fileURLToPath(new URL("../../", import.meta.url)));
  const tools: Tool[] = [{ name, description, parameters }, {
    name: "skill", description: "Load a matching specialized skill by name.",
    parameters: {
      type: "object", properties: { name: { type: "string" } },
      required: ["name"], additionalProperties: false,
    } as Tool["parameters"], // Provider accepts plain JSON Schema, not TypeBox runtime symbols.
  }];
  const report = {
    model: `${model.provider}/${model.id}`,
    sourceSkillHash: sha256(JSON.stringify(sources)), sources,
    fixturesHash: sha256(fixturesText), globalHash: sha256(globalText),
    systemPromptHash: sha256(systemPrompt),
    scope: "single-turn skill selection only; no skill bodies loaded or tools executed",
    fixtures: [] as ReturnType<typeof score>[],
    pass: false,
  };
  for (const fixture of fixtures) {
    const signal = AbortSignal.any([total, AbortSignal.timeout(60000)]);
    try {
      assert.equal((await runtime.checkAuth("openai-codex", { signal }))?.type,
        "oauth", "existing Codex OAuth required; no API-key fallback");
      const result = await runtime.complete(model, {
        systemPrompt, tools,
        messages: [{ role: "user", content: fixture.prompt, timestamp: Date.now() }],
      }, { signal, transport: "sse", reasoningEffort: "low", toolChoice: "auto", maxTokens: 2048 });
      report.fixtures.push(score(fixture, result, catalog));
    } catch (error) {
      report.fixtures.push(score(fixture, { content: [], stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error) }, catalog));
      break;
    }
    if (total.aborted) break;
  }
  report.pass = report.fixtures.length === fixtures.length && report.fixtures.every((row) => row.pass);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
