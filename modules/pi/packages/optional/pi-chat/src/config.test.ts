import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiscordAccountConfig } from "./core/config-types.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((temporaryPath) =>
        rm(temporaryPath, { recursive: true, force: true }),
      ),
  );
});

describe("chat config permissions", () => {
  it("sets config.json to owner-only after save and load", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-chat-home-"));
    temporaryPaths.push(home);
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const { CHAT_CONFIG_PATH, loadChatConfig, saveChatConfig } =
      await import("./config.js");

    await saveChatConfig({ botName: "pi", accounts: {} });
    expect((await stat(CHAT_CONFIG_PATH)).mode & 0o777).toBe(0o600);

    await chmod(CHAT_CONFIG_PATH, 0o644);
    await loadChatConfig();
    expect((await stat(CHAT_CONFIG_PATH)).mode & 0o777).toBe(0o600);
  });

  it("propagates malformed config instead of returning an empty config", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-chat-home-"));
    temporaryPaths.push(home);
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const { CHAT_CONFIG_PATH, ensureChatHome, loadChatConfig } =
      await import("./config.js");
    await ensureChatHome();
    await writeFile(CHAT_CONFIG_PATH, "{broken", { mode: 0o600 });
    await expect(loadChatConfig()).rejects.toBeInstanceOf(SyntaxError);
  });

  it("propagates config read errors other than ENOENT", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-chat-home-"));
    temporaryPaths.push(home);
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const { CHAT_CONFIG_PATH, ensureChatHome, loadChatConfig } =
      await import("./config.js");
    await ensureChatHome();
    await mkdir(CHAT_CONFIG_PATH);
    await expect(loadChatConfig()).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("atomically replaces config without leaving temporary files", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-chat-home-"));
    temporaryPaths.push(home);
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const { CHAT_CONFIG_PATH, CHAT_HOME, saveChatConfig } =
      await import("./config.js");
    await saveChatConfig({ botName: "first", accounts: {} });
    await saveChatConfig({ botName: "second", accounts: {} });
    expect((await stat(CHAT_CONFIG_PATH)).mode & 0o777).toBe(0o600);
    expect(
      (await readdir(CHAT_HOME)).filter((name) => name.includes(".tmp")),
    ).toEqual([]);
  });

  it("rejects channels without explicit access", async () => {
    const { validateChatConfig } = await import("./config.js");
    const account: DiscordAccountConfig = {
      service: "discord" as const,
      botToken: "token",
      applicationId: "app",
      serverId: "server",
      serverName: "server",
      channels: { public: { id: "public" } },
    };
    expect(() =>
      validateChatConfig({ accounts: { discord: account } }),
    ).toThrow("explicitly allowed user or role");
    account.channels.public = {
      id: "public",
      access: { allowedRoleIds: ["admins"] },
    };
    expect(() =>
      validateChatConfig({ accounts: { discord: account } }),
    ).not.toThrow();

    account.channels.public = {
      id: "dm",
      dm: true,
      access: { allowedRoleIds: ["admins"] },
    };
    expect(() =>
      validateChatConfig({ accounts: { discord: account } }),
    ).toThrow("explicitly allowed user");
    account.channels.public = {
      id: "dm",
      dm: true,
      access: { allowedUserIds: ["owner"] },
    };
    expect(() =>
      validateChatConfig({ accounts: { discord: account } }),
    ).not.toThrow();
  });

  it("keeps path-like and colliding account keys in distinct storage directories", async () => {
    const { listConfiguredConversations } = await import("./config.js");
    const account = (id: string): DiscordAccountConfig => ({
      service: "discord",
      botToken: "token",
      applicationId: "app",
      serverId: "server",
      serverName: "server",
      channels: {
        channel: { id, access: { allowedUserIds: ["owner"] } },
      },
    });
    const conversations = listConfiguredConversations({
      accounts: {
        "..": account("one"),
        "a:b": account("two"),
        "a?b": account("three"),
      },
    });
    expect(new Set(conversations.map((item) => item.accountDir)).size).toBe(3);
    expect(
      conversations.every((item) =>
        item.accountDir.startsWith(item.conversationDir.split("/channels/")[0]),
      ),
    ).toBe(true);
  });
});
