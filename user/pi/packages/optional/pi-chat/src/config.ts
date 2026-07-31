import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  AccessPolicy,
  ChatAccountConfig,
  ChatConfig,
  ConfiguredChannel,
  GondolinConfig,
  GondolinSecretConfig,
  ResolvedConversation,
} from "./core/config-types.js";

export const CHAT_HOME = join(homedir(), ".pi", "agent", "chat");
export const CHAT_CONFIG_PATH = join(CHAT_HOME, "config.json");
export const CHAT_CACHE_DIR = join(CHAT_HOME, "cache");

function sanitizePathSegment(value: string): string {
  const readable =
    value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "item";
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${readable.slice(0, 63)}-${hash}`;
}

function getAccountStorageDir(accountId: string): string {
  return join(CHAT_HOME, "accounts", sanitizePathSegment(accountId));
}

function getChannelStorageDir(accountId: string, channelKey: string): string {
  return join(
    getAccountStorageDir(accountId),
    "channels",
    sanitizePathSegment(channelKey),
  );
}

function mergeAccess(
  ...policies: Array<AccessPolicy | undefined>
): AccessPolicy {
  const merged: AccessPolicy = {};
  for (const policy of policies) {
    if (!policy) continue;
    if (policy.trigger !== undefined) merged.trigger = policy.trigger;
    if (policy.ignoreBots !== undefined) merged.ignoreBots = policy.ignoreBots;
    if (policy.allowedUserIds !== undefined)
      merged.allowedUserIds = [...policy.allowedUserIds];
    if (policy.allowedRoleIds !== undefined)
      merged.allowedRoleIds = [...policy.allowedRoleIds];
  }
  return merged;
}

function mergeGondolinSecrets(
  ...configs: Array<GondolinConfig | undefined>
): Record<string, GondolinSecretConfig> {
  const merged: Record<string, GondolinSecretConfig> = {};
  for (const config of configs) {
    for (const [name, secret] of Object.entries(config?.secrets ?? {})) {
      merged[name] = { value: secret.value, hosts: [...secret.hosts] };
    }
  }
  return merged;
}

function buildResolvedConversation(
  config: ChatConfig,
  accountId: string,
  channelKey: string,
  channel: ConfiguredChannel,
): ResolvedConversation {
  const account = config.accounts[accountId];
  if (!account) throw new Error(`Unknown account: ${accountId}`);
  const access = mergeAccess(account.access, channel.access);
  validateChatConfig({
    ...config,
    accounts: {
      [accountId]: { ...account, channels: { [channelKey]: channel } },
    },
  });
  const accountDir = getAccountStorageDir(accountId);
  const conversationDir = getChannelStorageDir(accountId, channelKey);
  const workspaceDir = join(conversationDir, "workspace");
  return {
    service: account.service,
    botName: config.botName?.trim() || "pi",
    accountId,
    account,
    channelKey,
    channel,
    conversationId: `${accountId}/${channelKey}`,
    conversationName: `${account.name ?? accountId} / ${channel.name ?? channelKey}`,
    access,
    gondolinSecrets: mergeGondolinSecrets(
      config.gondolin,
      account.gondolin,
      channel.gondolin,
    ),
    accountDir,
    sharedDir: join(accountDir, "shared"),
    conversationDir,
    workspaceDir,
    gondolinDir: join(conversationDir, "gondolin"),
    accountMemoryPath: join(accountDir, "shared", "memory.md"),
    channelMemoryPath: join(conversationDir, "workspace", "memory.md"),
    logPath: join(conversationDir, "channel.jsonl"),
    filesDir: join(workspaceDir, "incoming"),
    lockPath: join(conversationDir, ".lock"),
  };
}

export function validateChatConfig(config: ChatConfig): void {
  for (const [accountId, account] of Object.entries(config.accounts)) {
    for (const [channelKey, channel] of Object.entries(
      account.channels ?? {},
    )) {
      const access = mergeAccess(account.access, channel.access);
      const allowedUsers = access.allowedUserIds?.filter(Boolean) ?? [];
      const allowedRoles = access.allowedRoleIds?.filter(Boolean) ?? [];
      const label = `${accountId}/${channelKey}`;
      if (channel.dm) {
        if (allowedUsers.length === 0)
          throw new Error(
            `DM channel ${label} requires an explicitly allowed user`,
          );
      } else if (allowedUsers.length === 0 && allowedRoles.length === 0) {
        throw new Error(
          `Channel ${label} requires an explicitly allowed user or role`,
        );
      }
    }
  }
}

export async function ensureChatHome(): Promise<void> {
  await mkdir(CHAT_HOME, { recursive: true });
  await mkdir(CHAT_CACHE_DIR, { recursive: true });
}

export async function removeAccountStorage(
  accountId: string,
  _cwd: string,
): Promise<void> {
  await rm(getAccountStorageDir(accountId), { recursive: true, force: true });
  await rm(join(CHAT_CACHE_DIR, `${sanitizePathSegment(accountId)}.json`), {
    force: true,
  });
}

export async function removeChannelStorage(
  accountId: string,
  channelKey: string,
  _cwd: string,
): Promise<void> {
  await rm(getChannelStorageDir(accountId, channelKey), {
    recursive: true,
    force: true,
  });
}

export async function saveChatConfig(config: ChatConfig): Promise<void> {
  validateChatConfig(config);
  await ensureChatHome();
  const temporaryPath = `${CHAT_CONFIG_PATH}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, "\t")}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const temporaryHandle = await open(temporaryPath, "r+");
    try {
      await temporaryHandle.chmod(0o600);
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    await rename(temporaryPath, CHAT_CONFIG_PATH);
    const finalHandle = await open(CHAT_CONFIG_PATH, "r+");
    try {
      await finalHandle.chmod(0o600);
      await finalHandle.sync();
    } finally {
      await finalHandle.close();
    }
    const directoryHandle = await open(dirname(CHAT_CONFIG_PATH), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function loadChatConfig(): Promise<ChatConfig> {
  await ensureChatHome();
  let content: string;
  try {
    content = await readFile(CHAT_CONFIG_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { botName: "pi", accounts: {} };
    throw error;
  }
  await chmod(CHAT_CONFIG_PATH, 0o600);
  const parsed = JSON.parse(content) as ChatConfig;
  return {
    botName: parsed.botName?.trim() || "pi",
    gondolin: parsed.gondolin,
    accounts: (parsed.accounts ?? {}) as Record<string, ChatAccountConfig>,
  };
}

export function listConfiguredConversations(
  config: ChatConfig,
): ResolvedConversation[] {
  const conversations: ResolvedConversation[] = [];
  for (const [accountId, account] of Object.entries(config.accounts) as Array<
    [string, ChatAccountConfig]
  >) {
    for (const [channelKey, channel] of Object.entries(
      account.channels ?? {},
    ) as Array<[string, ConfiguredChannel]>) {
      conversations.push(
        buildResolvedConversation(config, accountId, channelKey, channel),
      );
    }
  }
  return conversations.sort((a, b) =>
    a.conversationId.localeCompare(b.conversationId),
  );
}

export function resolveConversation(
  config: ChatConfig,
  spec: string,
): ResolvedConversation | undefined {
  const trimmed = spec.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return undefined;
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length !== 2) return undefined;
  const [accountId, channelKey] = parts;
  const account = config.accounts[accountId];
  const channel = account?.channels?.[channelKey];
  if (!account || !channel) return undefined;
  return buildResolvedConversation(config, accountId, channelKey, channel);
}
