import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import {
  listSessions,
  readSession,
  resolveNativeSessionRoot,
  resolveNativeSessionSelection,
} from "@bds_pi/sessions";
import { MentionAutocompleteProvider, parseMentions } from "@bds_pi/mentions";

/** SDK listAll(undefined) discovers grouped workspaces; a string means flat. */
export function historySessionDir(
  ctx: Pick<ExtensionContext, "sessionManager"> &
    Partial<Pick<ExtensionContext, "cwd">>,
): string | undefined {
  const selection = resolveNativeSessionSelection({
    cwd: ctx.cwd,
    sessionManager: ctx.sessionManager,
  });
  return selection.kind === "flat" ? selection.root : undefined;
}

// SDK entries can contain arbitrary extension data; preserve it as JSON rather
// than maintaining a second schema for the SDK's transcript union.
function outputSchema(value: TSchema): TSchema {
  return Type.Union([
    Type.Object({ ok: Type.Literal(true), value }),
    Type.Object({
      ok: Type.Literal(false),
      error: Type.Object({
        code: Type.String(),
        message: Type.String(),
        candidates: Type.Optional(Type.Array(Type.Unknown())),
        path: Type.Optional(Type.String()),
      }),
    }),
  ]);
}

const identityFields = {
  sessionId: Type.String(),
  workspace: Type.String(),
  sessionFile: Type.Union([Type.String(), Type.Null()]),
  sessionDir: Type.Union([Type.String(), Type.Null()]),
  parentSessionFile: Type.Union([Type.String(), Type.Null()]),
};
const listOutputSchema = outputSchema(
  Type.Array(
    Type.Object({
      ...identityFields,
      name: Type.Union([Type.String(), Type.Null()]),
      firstMessage: Type.String(),
      created: Type.String(),
      modified: Type.String(),
    }),
  ),
);
const readOutputSchema = outputSchema(
  Type.Object({
    ...identityFields,
    selection: Type.Union([
      Type.Literal("entry"),
      Type.Literal("persisted-last-entry"),
      Type.Literal("current"),
    ]),
    leafId: Type.Union([Type.String(), Type.Null()]),
    rootEntryId: Type.Union([Type.String(), Type.Null()]),
    entries: Type.Array(
      Type.Object(
        {
          type: Type.String(),
          id: Type.String(),
          parentId: Type.Union([Type.String(), Type.Null()]),
          timestamp: Type.String(),
        },
        { additionalProperties: true },
      ),
    ),
  }),
);

export default function sessionHistory(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "history_list",
    label: "List session history",
    description:
      "List native pi session metadata. Metadata covers whole files, not selected branches. Omit workspace for all workspaces. Use rg/qmd for deliberate text search, not personal-memory fallback.",
    exposure: "codemode",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    parameters: Type.Object({
      workspace: Type.Optional(Type.String()),
      sessionDir: Type.Optional(Type.String()),
    }),
    outputSchema: listOutputSchema,
    async execute(_id, args, signal, _update, ctx) {
      const result = await listSessions(
        {
          ...args,
          sessionDir: args.sessionDir ?? historySessionDir(ctx),
        },
        undefined,
        signal,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: JSON.parse(JSON.stringify(result)),
        details: result,
        isError: !result.ok,
      };
    },
  });
  pi.registerTool({
    name: "history_read",
    label: "Read session history",
    description:
      "Read raw entries on one branch of a native pi session, without a model call. Workspace must match exactly. Specify entryId for reproducibility; otherwise selects the last persisted entry, NOT necessarily the live active leaf. Deliberate history access is not personal-memory retrieval.",
    exposure: "codemode",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    parameters: Type.Object({
      workspace: Type.String(),
      sessionId: Type.String(),
      sessionDir: Type.Optional(Type.String()),
      entryId: Type.Optional(Type.String()),
    }),
    outputSchema: readOutputSchema,
    async execute(_id, args, signal, _update, ctx) {
      const result = await readSession(
        {
          workspace: args.workspace,
          source: {
            kind: "id",
            sessionId: args.sessionId,
            sessionDir: args.sessionDir ?? historySessionDir(ctx),
          },
          branch:
            args.entryId === undefined
              ? { kind: "persisted-last-entry" }
              : { kind: "entry", entryId: args.entryId },
        },
        undefined,
        signal,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: JSON.parse(JSON.stringify(result)),
        details: result,
        isError: !result.ok,
      };
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.addAutocompleteProvider(
      (baseProvider) =>
        new MentionAutocompleteProvider({
          baseProvider,
          context: { cwd: ctx.cwd },
          source: {
            kind: "session",
            description: "previous pi session",
            async getSuggestions(query) {
              const result = await listSessions({
                sessionDir: historySessionDir(ctx),
              });
              if (!result.ok) throw new Error(result.error.message);
              return result.value
                .filter((s) =>
                  s.sessionId.toLowerCase().startsWith(query.toLowerCase()),
                )
                .slice(0, 8)
                .map((s) => ({
                  value: `@session/${s.sessionId}`,
                  label: `@session/${s.sessionId}`,
                  description: s.name || s.firstMessage || s.workspace,
                }));
            },
            async resolve(token) {
              const result = await listSessions({
                sessionDir: historySessionDir(ctx),
              });
              if (!result.ok) throw new Error(result.error.message);
              const exact = result.value.filter(
                (s) => s.sessionId === token.value,
              );
              const matches = exact.length
                ? exact
                : result.value.filter((s) =>
                    s.sessionId.startsWith(token.value),
                  );
              const session = matches.length === 1 ? matches[0] : undefined;
              if (!session)
                return {
                  token,
                  status: "unresolved",
                  reason:
                    matches.length > 1
                      ? "session_prefix_ambiguous"
                      : "session_not_found",
                };
              return {
                token,
                status: "resolved",
                kind: "session",
                session: {
                  sessionId: session.sessionId,
                  sessionName: session.name ?? "",
                  workspace: session.workspace,
                  startedAt: session.created,
                  updatedAt: session.modified,
                  firstUserMessage: session.firstMessage,
                  parentSessionPath: session.parentSessionFile ?? undefined,
                },
              };
            },
          },
        }),
    );
  });
  pi.on("before_agent_start", async (event) => {
    if (!parseMentions(event.prompt).some((m) => m.kind === "session")) return;
    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n@session/<id-or-prefix> points to native pi history. Use history_list to identify its workspace, then history_read through codemode before relying on contents. Specify an entryId when branch identity matters; last persisted entry is not necessarily the live active leaf.",
    };
  });
}

if (import.meta.vitest) {
  const { it, expect, vi } = import.meta.vitest;
  it("finds native history for ephemeral managers from settings/env without overriding persistent context", async () => {
    const fs = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { SessionManager, getAgentDir } =
      await import("@earendil-works/pi-coding-agent");
    const root = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), "pi-history-root-")),
    );
    const dir = join(root, "history");
    const cwd = join(root, "workspace");
    const manager = SessionManager.create(cwd, dir, {
      id: "custom-root-history",
    });
    manager.appendMessage({
      role: "user",
      content: "custom root question",
      timestamp: 1,
    });
    const ephemeral = SessionManager.inMemory(cwd);
    try {
      vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
      vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", undefined);
      await fs.mkdir(getAgentDir(), { recursive: true });
      await fs.writeFile(
        join(getAgentDir(), "settings.json"),
        JSON.stringify({ sessionDir: dir }),
      );
      await fs.mkdir(join(cwd, ".pi"), { recursive: true });
      await fs.writeFile(
        join(cwd, ".pi/settings.json"),
        JSON.stringify({ sessionDir: join(root, "untrusted-project-root") }),
      );
      const ctx = { cwd, sessionManager: ephemeral };
      expect(
        await listSessions({ sessionDir: historySessionDir(ctx) }),
      ).toMatchObject({
        ok: true,
        value: [
          {
            sessionId: "custom-root-history",
            firstMessage: "custom root question",
          },
        ],
      });
      expect(
        resolveNativeSessionRoot({
          cwd,
          sessionManager: ephemeral,
          allowProjectConfig: true,
        }),
      ).toBe(join(root, "untrusted-project-root"));
      vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", dir);
      await fs.writeFile(join(getAgentDir(), "settings.json"), "{broken");
      expect(
        await listSessions({ sessionDir: historySessionDir(ctx) }),
      ).toMatchObject({
        ok: true,
        value: [{ sessionId: "custom-root-history" }],
      });
      vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", join(root, "wrong"));
      expect(historySessionDir({ cwd, sessionManager: manager })).toBe(dir);
      expect(
        resolveNativeSessionRoot({
          cwd,
          sessionManager: ephemeral,
          settings: {},
        }),
      ).toBe(join(root, "wrong"));
      vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", undefined);
      expect(
        resolveNativeSessionRoot({
          cwd,
          sessionManager: ephemeral,
          settings: {},
        }),
      ).toBe(join(getAgentDir(), "sessions"));
      // supplied snapshots must not reread the malformed settings file.
      expect(
        resolveNativeSessionSelection({
          cwd,
          sessionManager: ephemeral,
          settings: {},
        }),
      ).toEqual({ root: join(getAgentDir(), "sessions"), kind: "grouped" });
      expect(
        resolveNativeSessionSelection({
          cwd,
          sessionManager: ephemeral,
          settings: { sessionDir: join(getAgentDir(), "sessions") },
        }),
      ).toEqual({ root: join(getAgentDir(), "sessions"), kind: "flat" });
      await fs.writeFile(join(getAgentDir(), "settings.json"), "{}");
      const native = SessionManager.create(cwd);
      native.appendMessage({
        role: "user",
        content: "grouped question",
        timestamp: 2,
      });
      for (const sessionManager of [native, ephemeral]) {
        expect(
          await listSessions({
            sessionDir: historySessionDir({ cwd, sessionManager }),
          }),
        ).toMatchObject({
          ok: true,
          value: [{ sessionId: native.getSessionId() }],
        });
      }
      // the same root path can be explicitly selected as a FLAT directory.
      const flatRoot = join(getAgentDir(), "sessions");
      const flat = SessionManager.create(cwd, flatRoot, { id: "flat-at-root" });
      flat.appendMessage({
        role: "user",
        content: "flat question",
        timestamp: 3,
      });
      vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", flatRoot);
      for (const sessionManager of [flat, ephemeral]) {
        expect(
          await listSessions({
            sessionDir: historySessionDir({ cwd, sessionManager }),
          }),
        ).toMatchObject({
          ok: true,
          value: [{ sessionId: "flat-at-root" }],
        });
      }
      vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", undefined);
      await fs.writeFile(
        join(getAgentDir(), "settings.json"),
        JSON.stringify({ sessionDir: flatRoot }),
      );
      expect(
        await listSessions({ sessionDir: historySessionDir(ctx) }),
      ).toMatchObject({
        ok: true,
        value: [{ sessionId: "flat-at-root" }],
      });
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("dispatches real codemode calls through the SDK to the same history outcomes", async () => {
    const fs = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const {
      createAgentSession,
      createCodemodeExtension,
      DefaultResourceLoader,
      ModelRuntime,
      SessionManager,
      SettingsManager,
    } = await import("@earendil-works/pi-coding-agent");
    const {
      InMemoryCredentialStore,
      fauxProvider,
      fauxAssistantMessage,
      fauxToolCall,
    } = await import("@earendil-works/pi-ai");
    const root = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), "pi-history-sdk-")),
    );
    const cwd = join(root, "project");
    const dir = join(root, "history");
    await fs.mkdir(cwd);
    const manager = SessionManager.create(cwd, dir, { id: "sdk-history" });
    const first = manager.appendMessage({
      role: "user",
      content: "common",
      timestamp: 1,
    });
    const left = manager.appendMessage({
      role: "user",
      content: "left",
      timestamp: 2,
    });
    manager.branch(first);
    manager.appendMessage({
      role: "user",
      content: "excluded sibling",
      timestamp: 3,
    });
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      refreshOnCreate: false,
      modelsPath: null,
    });
    const faux = fauxProvider();
    runtime.registerNativeProvider(faux.provider);
    const settings = SettingsManager.inMemory({
      defaultTools: ["codemode"],
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: root,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        sessionHistory,
        createCodemodeExtension({ models: false }),
      ],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir: root,
      settingsManager: settings,
      resourceLoader: loader,
      modelRuntime: runtime,
      model: faux.getModel(),
      sessionManager: SessionManager.inMemory(cwd),
    });
    try {
      await session.bindExtensions({});
      expect(historySessionDir({ sessionManager: manager })).toBe(dir);
      const args = {
        workspace: cwd,
        sessionId: manager.getSessionId(),
        entryId: left,
        sessionDir: dir,
      };
      const expected = {
        listed: await listSessions({ sessionDir: dir }),
        read: await readSession({
          workspace: cwd,
          source: { kind: "id", sessionId: args.sessionId, sessionDir: dir },
          branch: { kind: "entry", entryId: left },
        }),
        missing: await readSession({
          workspace: cwd,
          source: { kind: "id", sessionId: "absent", sessionDir: dir },
          branch: { kind: "persisted-last-entry" },
        }),
        wrong: await readSession({
          workspace: root,
          source: { kind: "id", sessionId: args.sessionId, sessionDir: dir },
          branch: { kind: "persisted-last-entry" },
        }),
      };
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("codemode", {
            code: `
        return {
          listed: await tools.history_list(${JSON.stringify({ sessionDir: dir })}),
          read: await tools.history_read(${JSON.stringify(args)}),
          missing: await tools.history_read(${JSON.stringify({ workspace: cwd, sessionId: "absent", sessionDir: dir })}),
          wrong: await tools.history_read(${JSON.stringify({ workspace: root, sessionId: args.sessionId, sessionDir: dir })})
        };
      `,
          }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ]);
      await session.prompt("exercise native history");
      const result = session.messages.find(
        (m) => m.role === "toolResult" && m.toolName === "codemode",
      );
      if (!result || result.role !== "toolResult")
        throw new Error("missing codemode result");
      const text = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      expect(text).toContain("Script completed");
      expect(JSON.parse(text.split("Output:\n")[1] ?? "")).toEqual(
        JSON.parse(JSON.stringify(expected)),
      );
      expect(text).not.toContain("excluded sibling");
      expect(manager.getLeafId()).not.toBe(left);
    } finally {
      session.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
