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
import {
  historyContent,
  historyFailure,
  historyPage,
  historyResponse,
  previewSession,
  validIndex,
  validPage,
} from "./paging";

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
function outputSchema(
  value: TSchema,
  fields: Record<string, TSchema> = {},
): TSchema {
  return Type.Union([
    Type.Object({ ok: Type.Literal(true), value, ...fields }),
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
const pageSchema = Type.Object({
  offset: Type.Number(),
  nextOffset: Type.Union([Type.Number(), Type.Null()]),
  total: Type.Number(),
});
const listOutputSchema = outputSchema(
  Type.Array(
    Type.Object({
      ...identityFields,
      name: Type.Union([Type.String(), Type.Null()]),
      firstMessage: Type.String(),
      truncatedFields: Type.Optional(Type.Array(Type.String())),
      created: Type.String(),
      modified: Type.String(),
    }),
  ),
  { page: pageSchema },
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
  {
    page: Type.Optional(pageSchema),
    omitted: Type.Optional(
      Type.Array(
        Type.Object({
          entryId: Type.String(),
          type: Type.String(),
          bytes: Type.Number(),
        }),
      ),
    ),
    content: Type.Optional(
      Type.Object({
        entryId: Type.String(),
        text: Type.String(),
        offset: Type.Number(),
        nextOffset: Type.Union([Type.Number(), Type.Null()]),
        total: Type.Number(),
      }),
    ),
  },
);

export default function sessionHistory(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "history_list",
    label: "List session history",
    description:
      "List bounded pages of native pi session metadata, newest activity first. Omit workspace for all workspaces. Default limit 20, maximum 100; follow page.nextOffset (null means done). Offsets are best effort over mutable discovery, not a snapshot. name/firstMessage are 512-character previews; truncatedFields identifies shortened fields. Metadata covers whole files, not selected branches.",
    exposure: "codemode",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    parameters: Type.Object({
      workspace: Type.Optional(Type.String()),
      sessionDir: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
    outputSchema: listOutputSchema,
    execute(_id, args, signal, _update, ctx) {
      return historyResponse(async () => {
        if (!validPage(args.offset, args.limit))
          return historyFailure(
            "invalid_argument",
            "offset must be a nonnegative safe integer; limit must be 1–100",
          );
        const result = await listSessions(
          {
            workspace: args.workspace,
            sessionDir: args.sessionDir ?? historySessionDir(ctx),
          },
          undefined,
          signal,
        );
        if (!result.ok) return result;
        return historyPage(
          result.value.map(previewSession),
          args.offset ?? 0,
          args.limit ?? 20,
          (value, page) => ({ ok: true as const, value, page }),
        );
      });
    },
  });
  pi.registerTool({
    name: "history_read",
    label: "Read session history",
    description:
      "Read bounded pages on a native pi session branch. Workspace must match exactly. Default limit 40, maximum 100; offsets count native entries examined, including omitted ones. Follow page.nextOffset; pin entryId to the returned value.leafId on every continuation. Without entryId the first page selects the last persisted entry, NOT necessarily the live active leaf. Oversized entries are listed in omitted, not silently truncated. Retrieve one with contentId and pinned entryId: content.text is a bounded fragment of JSON.stringify(nativeEntry); follow content.nextOffset (JavaScript string indices) until null. Fragments need not parse individually. Do not mix contentId/contentOffset with page offset/limit. Responses are at most 64 KiB including the SDK envelope; native files are unchanged.",
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
      offset: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
      contentId: Type.Optional(Type.String()),
      contentOffset: Type.Optional(Type.Number()),
    }),
    outputSchema: readOutputSchema,
    execute(_id, args, signal, _update, ctx) {
      return historyResponse(async () => {
        if (
          !validPage(args.offset, args.limit) ||
          !validIndex(args.contentOffset)
        )
          return historyFailure(
            "invalid_argument",
            "offsets must be nonnegative safe integers; limit must be 1–100",
          );
        if (
          (args.contentId === undefined && args.contentOffset !== undefined) ||
          (args.contentId !== undefined &&
            (args.offset !== undefined || args.limit !== undefined))
        )
          return historyFailure(
            "invalid_argument",
            "do not mix page and content controls; contentOffset requires contentId",
          );
        if (
          ((args.offset ?? 0) > 0 || args.contentId !== undefined) &&
          args.entryId === undefined
        )
          return historyFailure(
            "branch_required",
            "pin entryId to the first page's value.leafId for continuation or entry content",
          );
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
        if (!result.ok) return result;
        const history = result.value;
        if (args.contentId !== undefined)
          return historyContent(
            history,
            args.contentId,
            args.contentOffset ?? 0,
          );
        return historyPage(
          history.entries,
          args.offset ?? 0,
          args.limit ?? 40,
          (entries, page, omitted) => ({
            ok: true as const,
            value: { ...history, entries },
            page,
            omitted,
          }),
          (entry, bytes) => ({ entryId: entry.id, type: entry.type, bytes }),
        );
      });
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
    if (
      event.messageType !== "user" ||
      !parseMentions(event.prompt).some((m) => m.kind === "session")
    )
      return;
    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n@session/<id-or-prefix> points to native pi history. Use history_list to identify its workspace, then history_read through codemode before relying on contents. Follow page.nextOffset and pin entryId to the returned leafId on subsequent pages. Oversized entries are explicit omissions with bounded contentId retrieval. Last persisted entry is not necessarily the live active leaf.",
    };
  });
}

if (import.meta.vitest) {
  const { it, expect, vi } = import.meta.vitest;
  it("adds history guidance only for user prompts, not custom-message runs", async () => {
    let beforeStart!: (event: unknown) => Promise<unknown>;
    sessionHistory({
      registerTool() {},
      on(name: string, handler: typeof beforeStart) {
        if (name === "before_agent_start") beforeStart = handler;
      },
    } as unknown as ExtensionAPI);
    expect(await beforeStart({ messageType: "custom" })).toBeUndefined();
    expect(
      await beforeStart({ messageType: "user", prompt: "hello" }),
    ).toBeUndefined();
    expect(
      await beforeStart({
        messageType: "user",
        prompt: "inspect @session/abcdef1",
        systemPrompt: "base",
      }),
    ).toMatchObject({ systemPrompt: expect.stringContaining("history_read") });
  });
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
    const large = manager.appendMessage({
      role: "toolResult",
      toolCallId: "large",
      toolName: "fixture",
      content: [{ type: "text", text: '\"\\\\\\n😀'.repeat(6000) }],
      isError: false,
      timestamp: 3,
    });
    const correction = manager.appendMessage({
      role: "user",
      content: "later correction",
      timestamp: 4,
    });
    manager.branch(first);
    const sibling = manager.appendMessage({
      role: "user",
      content: "excluded sibling",
      timestamp: 5,
    });
    const originalSource = await fs.readFile(manager.getSessionFile()!, "utf8");
    for (let i = 0; i < 30; i++) {
      const extra = SessionManager.create(join(root, "other"), dir, {
        id: `metadata-${i}`,
      });
      extra.appendMessage({
        role: "user",
        content: "metadata ".repeat(1000),
        timestamp: i,
      });
    }
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
      const listed = await listSessions({ sessionDir: dir, workspace: cwd });
      const read = await readSession({
        workspace: cwd,
        source: { kind: "id", sessionId: args.sessionId, sessionDir: dir },
        branch: { kind: "entry", entryId: left },
      });
      if (!listed.ok || !read.ok) throw new Error("native fixture failed");
      const expected = {
        listed: { ...listed, page: { offset: 0, nextOffset: null, total: 1 } },
        read: {
          ...read,
          page: { offset: 0, nextOffset: null, total: 2 },
          omitted: [],
        },
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
        const request = ${JSON.stringify({ ...args, entryId: correction })};
        let listing = await tools.history_list({sessionDir:${JSON.stringify(dir)}});
        const seen = new Set();
        for (;;) {
          if(!listing.ok || listing.value.length>20) throw new Error('unbounded list page');
          for(const item of listing.value){
            if(item.firstMessage.length>512 || (item.name?.length??0)>512) throw new Error('unbounded list preview');
            if(item.sessionId.startsWith('metadata-') && !item.truncatedFields.includes('firstMessage')) throw new Error('silent preview truncation');
            if(seen.has(item.sessionId)) throw new Error('duplicate list item');
            seen.add(item.sessionId);
          }
          if(listing.page.nextOffset===null) break;
          if(listing.page.nextOffset<=listing.page.offset) throw new Error('list cursor did not advance');
          listing=await tools.history_list({sessionDir:${JSON.stringify(dir)},offset:listing.page.nextOffset});
        }
        if(seen.size!==31) throw new Error('list pagination lost metadata');
        const page = await tools.history_read({...request, limit:2});
        if(!page.ok || page.page.nextOffset!==2 || page.omitted[0]?.entryId!==${JSON.stringify(large)}) throw new Error('huge entry was not explicitly omitted');
        const next = await tools.history_read({...request,offset:page.page.nextOffset});
        if(!next.ok || next.value.entries[0]?.id!==${JSON.stringify(correction)} || next.page.nextOffset!==null) throw new Error('lost later correction');
        const chunk = await tools.history_read({...request,contentId:${JSON.stringify(large)}});
        if(!chunk.ok || !chunk.content.text.startsWith('{') || chunk.content.nextOffset===null) throw new Error('missing bounded content');
        const sibling = await tools.history_read({...request,contentId:${JSON.stringify(sibling)}});
        if(sibling.ok || sibling.error.code!=='entry_not_found') throw new Error('sibling content leaked');
        const unpinned = await tools.history_read({...request,entryId:undefined,offset:1});
        if(unpinned.ok || unpinned.error.code!=='branch_required') throw new Error('unpinned continuation accepted');
        const mixed = await tools.history_read({...request,contentId:${JSON.stringify(large)},limit:1});
        if(mixed.ok || mixed.error.code!=='invalid_argument') throw new Error('mixed modes accepted');
        const bad = await tools.history_list({sessionDir:${JSON.stringify(dir)},limit:0});
        if(bad.ok || bad.error.code!=='invalid_argument') throw new Error('unbounded page accepted');
        return {
          listed: await tools.history_list(${JSON.stringify({ sessionDir: dir, workspace: cwd })}),
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
      expect(await fs.readFile(manager.getSessionFile()!, "utf8")).toBe(
        originalSource,
      );
    } finally {
      session.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
