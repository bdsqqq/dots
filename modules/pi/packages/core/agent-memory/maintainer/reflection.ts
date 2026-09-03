import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import type { MemoryConfig } from "../catalog.js";
import { observeMemoryOperation } from "../observability.js";
import { parseModelProposal, type ModelProposal } from "../schema.js";
import {
  canonicalJson,
  durableCreate,
  durableWrite,
  object,
  sha256,
  timestamp,
  v3Data,
  type JsonValue,
} from "./common.js";
import { invokeModelSingleton } from "./dispatcher.js";
import { RESOURCE_LIMITS } from "./policy.js";
import type { ArtifactRef } from "./workflows.js";

type ReflectionConfig = Pick<MemoryConfig, "data">;

export type PreparedReflection = {
  schemaVersion: 3;
  invocationId: string;
  workflowId: string;
  sourceId: string;
  sourceRevisionSha256: string;
  catalogSha256: string;
  targetHead: string;
  promptPolicyVersion: number;
  modelPolicyVersion: number;
  model: string;
  reasoning: string;
  preparedAt: string;
  prompt: ArtifactRef;
};

export type ReflectionOutput = {
  schemaVersion: 3;
  invocationId: string;
  preparedSha256: string;
  outputSha256: string;
  output: string;
  completedAt: string;
};

const preparedPath = (cfg: ReflectionConfig, invocationId: string): string =>
  v3Data(cfg, "reflections/prepared", `${invocationId}.json`);
const outputPath = (cfg: ReflectionConfig, invocationId: string): string =>
  v3Data(cfg, "reflections/outputs", `${invocationId}.json`);

function artifact(cfg: ReflectionConfig, bytes: string): ArtifactRef {
  if (Buffer.byteLength(bytes) > RESOURCE_LIMITS.maxArtifactBytes)
    throw new Error("reflection artifact exceeds size cap");
  const digest = sha256(bytes);
  const path = v3Data(cfg, "artifacts/sha256", digest.slice(0, 2), digest);
  if (!durableCreate(path, bytes) && readFileSync(path, "utf8") !== bytes)
    throw new Error("reflection artifact collision");
  return {
    relativePath: relative(v3Data(cfg), path),
    sha256: digest,
    bytes: Buffer.byteLength(bytes),
  };
}

function parsePrepared(value: unknown): PreparedReflection {
  if (
    !object(value) ||
    value.schemaVersion !== 3 ||
    typeof value.invocationId !== "string" ||
    !/^inv_[a-f0-9]{32}$/.test(value.invocationId) ||
    typeof value.workflowId !== "string" ||
    typeof value.sourceId !== "string" ||
    typeof value.sourceRevisionSha256 !== "string" ||
    typeof value.catalogSha256 !== "string" ||
    typeof value.targetHead !== "string" ||
    !/^[a-f0-9]{40,64}$/.test(value.targetHead) ||
    !Number.isSafeInteger(value.promptPolicyVersion) ||
    !Number.isSafeInteger(value.modelPolicyVersion) ||
    typeof value.model !== "string" ||
    typeof value.reasoning !== "string" ||
    !object(value.prompt)
  )
    throw new Error("invalid prepared reflection");
  timestamp(value.preparedAt, "reflection preparedAt");
  return value as PreparedReflection;
}

export function prepareReflection(
  cfg: ReflectionConfig,
  input: Omit<
    PreparedReflection,
    "schemaVersion" | "invocationId" | "prompt"
  > & {
    prompt: string;
  },
): PreparedReflection {
  const prompt = artifact(cfg, input.prompt);
  const binding = canonicalJson({
    ...input,
    prompt: { sha256: prompt.sha256, bytes: prompt.bytes },
  } as unknown as JsonValue);
  const invocationId = `inv_${sha256(binding).slice(0, 32)}`;
  const prepared: PreparedReflection = {
    schemaVersion: 3,
    invocationId,
    workflowId: input.workflowId,
    sourceId: input.sourceId,
    sourceRevisionSha256: input.sourceRevisionSha256,
    catalogSha256: input.catalogSha256,
    targetHead: input.targetHead,
    promptPolicyVersion: input.promptPolicyVersion,
    modelPolicyVersion: input.modelPolicyVersion,
    model: input.model,
    reasoning: input.reasoning,
    preparedAt: input.preparedAt,
    prompt,
  };
  const bytes = `${canonicalJson(prepared as unknown as JsonValue)}\n`;
  const path = preparedPath(cfg, invocationId);
  if (!durableCreate(path, bytes) && readFileSync(path, "utf8") !== bytes)
    throw new Error("prepared reflection collision");
  return prepared;
}

export function loadPreparedReflection(
  cfg: ReflectionConfig,
  invocationId: string,
): PreparedReflection {
  return parsePrepared(
    JSON.parse(readFileSync(preparedPath(cfg, invocationId), "utf8")),
  );
}

function preparedDigest(prepared: PreparedReflection): string {
  return sha256(canonicalJson(prepared as unknown as JsonValue));
}

export function loadReflectionOutput(
  cfg: ReflectionConfig,
  prepared: PreparedReflection,
): ReflectionOutput | undefined {
  const path = outputPath(cfg, prepared.invocationId);
  if (!existsSync(path)) return undefined;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !object(value) ||
    value.schemaVersion !== 3 ||
    value.invocationId !== prepared.invocationId ||
    value.preparedSha256 !== preparedDigest(prepared) ||
    typeof value.output !== "string" ||
    value.output.length > RESOURCE_LIMITS.maxArtifactBytes ||
    value.outputSha256 !== sha256(value.output)
  )
    throw new Error("invalid persisted reflection output");
  timestamp(value.completedAt, "reflection completedAt");
  return value as ReflectionOutput;
}

async function invokeReflectionImpl(
  cfg: ReflectionConfig,
  prepared: PreparedReflection,
  invoke: (prompt: string, prepared: PreparedReflection) => Promise<string>,
  clock: () => Date = () => new Date(),
): Promise<
  | { type: "completed"; output: ReflectionOutput; recovered: boolean }
  | { type: "busy" }
> {
  const recovered = loadReflectionOutput(cfg, prepared);
  if (recovered)
    return { type: "completed", output: recovered, recovered: true };
  const result = await invokeModelSingleton(cfg, async () => {
    const secondCheck = loadReflectionOutput(cfg, prepared);
    if (secondCheck) return { output: secondCheck, recovered: true };
    const prompt = readFileSync(
      v3Data(cfg, prepared.prompt.relativePath),
      "utf8",
    );
    if (
      Buffer.byteLength(prompt) !== prepared.prompt.bytes ||
      sha256(prompt) !== prepared.prompt.sha256
    )
      throw new Error("prepared reflection prompt changed");
    const output = await invoke(prompt, prepared);
    if (Buffer.byteLength(output) > RESOURCE_LIMITS.maxArtifactBytes)
      throw new Error("reflection output exceeds size cap");
    const record: ReflectionOutput = {
      schemaVersion: 3,
      invocationId: prepared.invocationId,
      preparedSha256: preparedDigest(prepared),
      outputSha256: sha256(output),
      output,
      completedAt: clock().toISOString(),
    };
    durableWrite(
      outputPath(cfg, prepared.invocationId),
      `${canonicalJson(record as unknown as JsonValue)}\n`,
    );
    return { output: record, recovered: false };
  });
  return result.type === "busy"
    ? result
    : { type: "completed", ...result.value };
}

export function invokeReflection(
  cfg: ReflectionConfig,
  prepared: PreparedReflection,
  invoke: (prompt: string, prepared: PreparedReflection) => Promise<string>,
  clock: () => Date = () => new Date(),
): ReturnType<typeof invokeReflectionImpl> {
  return observeMemoryOperation(
    {
      operation: "memory.model-invocation",
      operationId: prepared.invocationId,
      correlation: {
        workflowId: prepared.workflowId,
        invocationId: prepared.invocationId,
      },
      fields: {
        model: prepared.model,
        reasoning: prepared.reasoning,
        sourceRevisionSha256: prepared.sourceRevisionSha256,
        catalogSha256: prepared.catalogSha256,
        targetHead: prepared.targetHead,
      },
      result: (result) => ({
        outcome: result.type === "busy" ? "degraded" : "success",
        fields: {
          invocationOutcome: result.type,
          recovered: result.type === "completed" ? result.recovered : false,
        },
      }),
    },
    () => invokeReflectionImpl(cfg, prepared, invoke, clock),
  );
}

export function validateReflectionOutput(
  cfg: ReflectionConfig,
  prepared: PreparedReflection,
): ModelProposal {
  const output = loadReflectionOutput(cfg, prepared);
  if (!output) throw new Error("reflection output is not persisted");
  return parseModelProposal(output.output);
}

if (import.meta.vitest) {
  const { describe, expect, it, vi } = import.meta.vitest;
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const nodePath = await import("node:path");
  const join = (...paths: string[]) => nodePath.join(...paths);
  const { withMemoryWideEventFactory } = await import("../observability.js");

  const fixture = (cfg: ReflectionConfig, id: string) =>
    prepareReflection(cfg, {
      workflowId: `workflow-${id}`,
      sourceId: `source-${id}`,
      sourceRevisionSha256: sha256(`source-${id}`),
      catalogSha256: sha256("catalog"),
      targetHead: "a".repeat(40),
      promptPolicyVersion: 1,
      modelPolicyVersion: 1,
      model: "test/model",
      reasoning: "low",
      preparedAt: "2026-09-03T12:00:00.000Z",
      prompt: "return a skip object",
    });

  describe("split reflection", () => {
    it("recovers persisted output without model reinvocation", async () => {
      const cfg = { data: mkdtempSync(join(tmpdir(), "pi-reflection-")) };
      const prepared = fixture(cfg, "recovery");
      let calls = 0;
      const invoke = async () => {
        calls += 1;
        return '{"version":2,"action":"skip","reason":"nothing durable"}';
      };
      expect((await invokeReflection(cfg, prepared, invoke)).type).toBe(
        "completed",
      );
      expect(await invokeReflection(cfg, prepared, invoke)).toMatchObject({
        type: "completed",
        recovered: true,
      });
      expect(calls).toBe(1);
      expect(validateReflectionOutput(cfg, prepared)).toMatchObject({
        action: "skip",
      });
    });

    it("serializes model invocations across workflows", async () => {
      const cfg = { data: mkdtempSync(join(tmpdir(), "pi-reflection-")) };
      const first = fixture(cfg, "first");
      const second = fixture(cfg, "second");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const active = invokeReflection(cfg, first, async () => {
        await gate;
        return '{"version":2,"action":"skip","reason":"first"}';
      });
      await Promise.resolve();
      expect(
        await invokeReflection(
          cfg,
          second,
          async () => '{"version":2,"action":"skip","reason":"second"}',
        ),
      ).toEqual({ type: "busy" });
      release();
      expect((await active).type).toBe("completed");
    });

    it("keeps logger transport failure orthogonal to model outcome", async () => {
      const cfg = { data: mkdtempSync(join(tmpdir(), "pi-reflection-")) };
      const prepared = fixture(cfg, "logger-outage");
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await withMemoryWideEventFactory(
        () => {
          throw new Error("telemetry transport unavailable");
        },
        () =>
          invokeReflection(
            cfg,
            prepared,
            async () =>
              '{"version":2,"action":"skip","reason":"nothing durable"}',
          ),
      );

      expect(result.type).toBe("completed");
      expect(loadReflectionOutput(cfg, prepared)).toBeDefined();
      expect(stderr).toHaveBeenCalledOnce();
      stderr.mockRestore();
    });
  });
}
