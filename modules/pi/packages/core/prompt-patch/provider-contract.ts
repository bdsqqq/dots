import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Tool } from "@earendil-works/pi-ai";
import {
  createCodingTools,
  getPackageDir,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";

/**
 * Load the shipped extension inventory through the SDK, without session-start
 * handlers (maintenance, UI, and watchers) or tool execution. All current tool
 * registrations happen in factories. Loader errors must not shrink the test set.
 */
export async function loadProviderContractTools(
  built = false,
): Promise<Tool[]> {
  const cwd = fileURLToPath(new URL("../../../", import.meta.url));
  const manifest = JSON.parse(
    await readFile(resolve(cwd, "package.json"), "utf8"),
  );
  const paths: string[] = manifest.pi.extensions.map((path: string) =>
    resolve(
      cwd,
      built
        ? path
        : path
            .replace("./dist/extensions/", "packages/extensions/")
            .replace(/\.js$/, "/index.ts"),
    ),
  );
  // The loader is internal to this pinned SDK; no production dependency on it.
  const { loadExtensions } = await import(
    pathToFileURL(resolve(getPackageDir(), "dist/core/extensions/loader.js"))
      .href
  );
  const loaded: LoadExtensionsResult = await loadExtensions(paths, cwd);
  if (loaded.errors.length)
    throw new Error(
      `extension load failures: ${JSON.stringify(loaded.errors)}`,
    );
  if (loaded.extensions.length !== paths.length)
    throw new Error("extension inventory was not fully loaded");
  const tools = new Map<string, Tool>();
  for (const tool of createCodingTools(cwd)) tools.set(tool.name, tool);
  // Match SDK precedence: first extension registration wins over built-ins.
  const extensionNames = new Set<string>();
  for (const extension of loaded.extensions) {
    for (const { definition } of extension.tools.values()) {
      if (extensionNames.has(definition.name)) continue;
      extensionNames.add(definition.name);
      tools.set(definition.name, definition);
    }
  }
  for (const required of ["read_web_page", "web_search", "edit", "write"])
    if (!tools.has(required)) throw new Error(`missing tool: ${required}`);
  return [...tools.values()];
}

type CodexToolDeclaration = {
  name: string;
  strict?: boolean | null;
  type: string;
  parameters?: {
    type: string;
    required: string[];
    properties: Record<string, unknown>;
  };
};

export function getCodexRequestTools(payload: unknown): CodexToolDeclaration[] {
  const request = payload as {
    tools?: CodexToolDeclaration[];
    input?: Array<{ type?: string; tools?: CodexToolDeclaration[] }>;
  };
  // 1.4 declares tools in transcript items on models supporting incremental tools.
  return [
    ...(request.tools ?? []),
    ...(request.input ?? [])
      .filter((item) => item.type === "additional_tools")
      .flatMap((item) => item.tools ?? []),
  ];
}

if (import.meta.vitest) {
  const { it, expect, vi } = import.meta.vitest;
  const { InMemoryCredentialStore, normalizeContext } =
    await import("@earendil-works/pi-ai");
  const { stream } =
    await import("@earendil-works/pi-ai/api/openai-codex-responses");
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");

  it("launches the current unbundled SDK, not an aliased or bundled CLI", async () => {
    const { execFileSync } = await import("node:child_process");
    const cwd = fileURLToPath(new URL("../../../", import.meta.url));
    const sdk = JSON.parse(
      await readFile(resolve(getPackageDir(), "package.json"), "utf8"),
    );
    expect(sdk.bin.pi).toBe("dist/cli.js");
    expect(
      execFileSync(resolve(cwd, "node_modules/.bin/pi"), ["--version"], {
        encoding: "utf8",
        timeout: 15000,
      }).trim(),
    ).toBe(sdk.version);
  });

  it.runIf(process.env.PI_TEST_BUILT_TOOLS === "1")(
    "loads the built registry with the same wire schemas as source",
    async () => {
      const { convertResponsesTools } =
        await import("@earendil-works/pi-ai/api/openai-responses-shared");
      const source = await loadProviderContractTools();
      const built = await loadProviderContractTools(true);
      const options = {
        strict: null,
        supportsStrictMode: true,
        supportsOpenAIGrammarTools: true,
      };
      expect(convertResponsesTools(built, options)).toEqual(
        convertResponsesTools(source, options),
      );
    },
  );

  it("reads both Codex declaration locations without counting unrelated input", () => {
    const tool = (name: string) => ({ name, type: "function" });
    expect(
      getCodexRequestTools({
        tools: [tool("legacy")],
        input: [
          { type: "additional_tools", tools: [tool("incremental")] },
          { type: "message", tools: [tool("not-a-declaration")] },
        ],
      }).map(({ name }) => name),
    ).toEqual(["legacy", "incremental"]);
    expect(getCodexRequestTools({ input: [] })).toEqual([]);
  });

  it.each(["native", "legacy"])(
    "advertises the complete registry through the actual %s Codex request builder",
    async (mode) => {
      const tools = await loadProviderContractTools();
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        refreshOnCreate: false,
        modelsPath: null,
      });
      const model = runtime.getModel("openai-codex", "gpt-6-astra");
      if (!model || model.api !== "openai-codex-responses")
        throw new Error("Codex test model missing");
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("network forbidden"));
      let payload: CodexToolDeclaration[] | undefined;
      try {
        // Only token shape is needed before onPayload; no credential is read or sent.
        const token = `test.${Buffer.from(
          JSON.stringify({
            "https://api.openai.com/auth": {
              chatgpt_account_id: "offline-test",
            },
          }),
        ).toString("base64url")}.test`;
        const result = await stream(
          {
            ...model,
            api: "openai-codex-responses",
            ...(mode === "legacy"
              ? {
                  compat: {
                    ...model.compat,
                    supportsMidConvoSystemMessages: false,
                    supportsAdditionalTools: false,
                    supportsToolSearch: false,
                  },
                }
              : {}),
          },
          normalizeContext({
            messages: [
              { role: "user", content: "offline schema check", timestamp: 0 },
            ],
            tools,
          }),
          {
            apiKey: token,
            transport: "sse",
            onPayload(value) {
              payload = getCodexRequestTools(value);
              throw new Error("captured before transport");
            },
          },
        ).result();
        expect(result.errorMessage).toContain("captured before transport");
        expect(payload?.map((tool) => tool.name).sort()).toEqual(
          tools.map((tool) => tool.name).sort(),
        );
        expect(
          payload?.find((tool) => tool.name === "read_web_page"),
        ).toMatchObject({
          strict: false,
        });
        expect(
          payload?.find((tool) => tool.name === "web_search"),
        ).toMatchObject({
          strict: true,
        });
        for (const name of ["edit", "write"]) {
          const wire = payload?.find((tool) => tool.name === name);
          expect(wire).toMatchObject({
            type: "function",
            parameters: { type: "object" },
          });
          expect(wire?.parameters?.required).toContain("path");
          const properties = wire?.parameters?.properties;
          expect(properties?.path).toMatchObject({ type: "string" });
          if (name === "edit") {
            expect(wire?.parameters?.required).toContain("edits");
            expect(properties?.edits).toMatchObject({
              type: "array",
              items: {
                type: "object",
                required: ["oldText", "newText"],
                properties: {
                  oldText: { type: "string" },
                  newText: { type: "string" },
                },
              },
            });
          } else {
            expect(wire?.parameters?.required).toContain("content");
            expect(properties?.content).toMatchObject({ type: "string" });
          }
        }
        expect(payload?.some((tool) => tool.name === "apply_patch")).toBe(
          false,
        );
        expect(network).not.toHaveBeenCalled();
      } finally {
        network.mockRestore();
      }
    },
  );
}
