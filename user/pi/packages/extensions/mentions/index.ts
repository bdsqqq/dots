import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  registerEditorAutocompleteContributor,
  type EditorAutocompleteContributor,
} from "@bds_pi/editor-capabilities";
import {
  MentionAwareProvider,
  renderResolvedMentionsText,
  resolveMentions,
  clearSessionMentionCache,
  clearCommitIndexCache,
  type ResolvedMention,
} from "@bds_pi/mentions";

const CUSTOM_TYPE = "mentions:resolved";

type MentionProviderFactory = EditorAutocompleteContributor["enhance"];

export interface MentionAdapterDeps {
  registerAutocompleteContributor(
    contributor: EditorAutocompleteContributor,
  ): void;
  createMentionProvider: MentionProviderFactory;
  resolveMentions: typeof resolveMentions;
  renderResolvedMentionsText: typeof renderResolvedMentionsText;
  clearSessionMentionCache: typeof clearSessionMentionCache;
  clearCommitIndexCache: typeof clearCommitIndexCache;
}

const DEFAULT_DEPS: MentionAdapterDeps = {
  registerAutocompleteContributor: registerEditorAutocompleteContributor,
  createMentionProvider(baseProvider, context) {
    return new MentionAwareProvider({
      baseProvider,
      cwd: context.cwd,
    });
  },
  resolveMentions,
  renderResolvedMentionsText,
  clearSessionMentionCache,
  clearCommitIndexCache,
};

/**
 * resolves special @mentions into hidden turn-local context.
 * also registers mention autocomplete as an optional editor contributor.
 * context is injected per turn, not persisted, so old references dont accumulate.
 */
export function createMentionsExtension(deps: MentionAdapterDeps) {
  return function mentionsExtension(pi: ExtensionAPI): void {
    let activeMentionContext = "";

    deps.registerAutocompleteContributor({
      id: "mentions",
      enhance(baseProvider, context) {
        return deps.createMentionProvider(baseProvider, context);
      },
    });

    const clearActive = () => {
      activeMentionContext = "";
    };

    pi.on("input", async (event, ctx) => {
      if (event.source === "extension") return { action: "continue" as const };

      const mentions = await deps.resolveMentions(event.text, { cwd: ctx.cwd });
      const resolved = mentions.filter(
        (
          mention,
        ): mention is Extract<ResolvedMention, { status: "resolved" }> =>
          mention.status === "resolved",
      );

      activeMentionContext = deps.renderResolvedMentionsText(resolved);
      return { action: "continue" as const };
    });

    pi.on("context", async (event) => {
      const messages = event.messages.filter(
        (message: any) => message.customType !== CUSTOM_TYPE,
      );

      if (!activeMentionContext) return { messages };

      return {
        messages: [
          ...messages,
          {
            role: "custom",
            customType: CUSTOM_TYPE,
            content: activeMentionContext,
            display: false,
            timestamp: Date.now(),
          },
        ],
      };
    });

    pi.on("agent_end", async () => {
      clearActive();
    });

    pi.on("session_start", async () => {
      clearActive();
      deps.clearSessionMentionCache();
      deps.clearCommitIndexCache();
    });
  };
}

export const mentionsExtension: (pi: ExtensionAPI) => void =
  createMentionsExtension(DEFAULT_DEPS);

export default mentionsExtension;

