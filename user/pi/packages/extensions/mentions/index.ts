import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerEditorAutocompleteContributor } from "@bds_pi/editor-capabilities";
import {
  MentionAwareProvider,
  renderResolvedMentionsText,
  resolveMentions,
  clearSessionMentionCache,
  clearCommitIndexCache,
  type ResolvedMention,
} from "@bds_pi/mentions";

const CUSTOM_TYPE = "mentions:resolved";

/**
 * resolves special @mentions into hidden turn-local context.
 * also registers mention autocomplete as an optional editor contributor.
 * context is injected per turn, not persisted, so old references dont accumulate.
 */
export default function (pi: ExtensionAPI): void {
  let activeMentionContext = "";

  registerEditorAutocompleteContributor({
    id: "mentions",
    enhance(baseProvider, context) {
      return new MentionAwareProvider({
        baseProvider,
        cwd: context.cwd,
      });
    },
  });

  const clearActive = () => {
    activeMentionContext = "";
  };

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };

    const mentions = await resolveMentions(event.text, { cwd: ctx.cwd });
    const resolved = mentions.filter(
      (mention): mention is Extract<ResolvedMention, { status: "resolved" }> =>
        mention.status === "resolved",
    );

    activeMentionContext = renderResolvedMentionsText(resolved);
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
    clearSessionMentionCache();
    clearCommitIndexCache();
  });

  pi.on("session_switch", async () => {
    clearActive();
    clearSessionMentionCache();
    clearCommitIndexCache();
  });
}
