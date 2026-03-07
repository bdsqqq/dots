import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface MockExtensionApiHarness {
  pi: ExtensionAPI;
  tools: unknown[];
  commands: Array<{ name: string; command: unknown }>;
  handlers: Array<{ event: string; handler: unknown }>;
  emittedEvents: Array<{ event: string; payload: unknown }>;
  sentUserMessages: string[];
}

/**
 * minimal extension api harness for load-time extension tests.
 *
 * enough to capture registration side effects without spinning up a real pi
 * session or executing tool/command handlers.
 */
export function createMockExtensionApiHarness(): MockExtensionApiHarness {
  const tools: unknown[] = [];
  const commands: Array<{ name: string; command: unknown }> = [];
  const handlers: Array<{ event: string; handler: unknown }> = [];
  const emittedEvents: Array<{ event: string; payload: unknown }> = [];
  const sentUserMessages: string[] = [];

  const pi = {
    registerTool(tool: unknown) {
      tools.push(tool);
    },
    registerCommand(name: string, command: unknown) {
      commands.push({ name, command });
    },
    on(event: string, handler: unknown) {
      handlers.push({ event, handler });
    },
    sendUserMessage(message: string) {
      sentUserMessages.push(message);
    },
    events: {
      emit(event: string, payload: unknown) {
        emittedEvents.push({ event, payload });
      },
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    tools,
    commands,
    handlers,
    emittedEvents,
    sentUserMessages,
  };
}
