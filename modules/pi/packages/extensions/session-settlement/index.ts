import * as crypto from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "t3.thread-lifecycle.v1";

type SettlementOverride = "settled" | "active";

function registerSettlementCommand(
  pi: ExtensionAPI,
  name: "settle" | "unsettle",
  override: SettlementOverride,
): void {
  pi.registerCommand(name, {
    description:
      override === "settled"
        ? "Mark the current session as settled"
        : "Mark the current session as active",
    handler: async (_args, ctx) => {
      try {
        pi.appendEntry(ENTRY_TYPE, {
          version: 1,
          sessionId: ctx.sessionManager.getSessionId(),
          override,
          operationId: crypto.randomUUID(),
        });
        ctx.ui.notify(
          override === "settled"
            ? "Session marked settled"
            : "Session marked active",
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to ${name} session: ${message}`, "error");
      }
    },
  });
}

export default function sessionSettlementExtension(pi: ExtensionAPI): void {
  registerSettlementCommand(pi, "settle", "settled");
  registerSettlementCommand(pi, "unsettle", "active");
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  function harness() {
    const commands = new Map<
      string,
      { handler: (args: string, ctx: any) => Promise<void> }
    >();
    const entries: Array<{ customType: string; data: any }> = [];
    let appendError: Error | undefined;
    const pi = {
      registerCommand: (name: string, command: unknown) =>
        commands.set(name, command as never),
      appendEntry: (customType: string, data: unknown) => {
        if (appendError) throw appendError;
        entries.push({ customType, data });
      },
    } as unknown as ExtensionAPI;
    sessionSettlementExtension(pi);
    return {
      commands,
      entries,
      failAppend: (error: Error) => {
        appendError = error;
      },
    };
  }

  function context(getSessionId: () => string) {
    const notifications: Array<{ message: string; level: string }> = [];
    return {
      ctx: {
        sessionManager: { getSessionId },
        ui: {
          notify: (message: string, level: string) =>
            notifications.push({ message, level }),
        },
      },
      notifications,
    };
  }

  describe("session-settlement", () => {
    it("registers settle and unsettle commands", () => {
      expect([...harness().commands.keys()]).toEqual(["settle", "unsettle"]);
    });

    it("appends lifecycle overrides for the current session", async () => {
      const h = harness();
      let sessionId = "session-one";
      const c = context(() => sessionId);

      await h.commands.get("settle")!.handler("", c.ctx);
      sessionId = "session-two";
      await h.commands.get("unsettle")!.handler("", c.ctx);

      const entriesByOverride = new Map(
        h.entries.map((entry) => [entry.data.override, entry]),
      );
      const settledEntry = entriesByOverride.get("settled");
      const activeEntry = entriesByOverride.get("active");
      expect(entriesByOverride.size).toBe(2);
      expect(settledEntry).toMatchObject({
        customType: ENTRY_TYPE,
        data: {
          version: 1,
          sessionId: "session-one",
          override: "settled",
        },
      });
      expect(activeEntry).toMatchObject({
        customType: ENTRY_TYPE,
        data: {
          version: 1,
          sessionId: "session-two",
          override: "active",
        },
      });
      expect(settledEntry!.data.operationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(activeEntry!.data.operationId).not.toBe(
        settledEntry!.data.operationId,
      );
      expect(c.notifications).toEqual([
        { message: "Session marked settled", level: "info" },
        { message: "Session marked active", level: "info" },
      ]);
    });

    it("reports append failures without claiming success", async () => {
      const h = harness();
      const c = context(() => "session-one");
      h.failAppend(new Error("disk full"));

      await h.commands.get("settle")!.handler("", c.ctx);

      expect(h.entries).toEqual([]);
      expect(c.notifications).toEqual([
        { message: "Failed to settle session: disk full", level: "error" },
      ]);
    });
  });
}
