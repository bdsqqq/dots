import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

process.umask(0o077);

type Entry = {
  type: string;
  id: string;
  parentId: string | null;
  [key: string]: unknown;
};
type Header = {
  type: "session";
  id: string;
  cwd: string;
  [key: string]: unknown;
};
type Snapshot = {
  source: string;
  header: Header;
  entries: Entry[];
  chains: Entry[][];
};
type Job = {
  version: 1;
  sessionId: string;
  checkpointEntryId: string;
  sourcePath: string;
  projectionPath: string;
  workspace: string;
};

const HOME = homedir();
const envPath = (name: string, fallback: string): string =>
  resolve((process.env[name] || fallback).replace(/^~(?=$|\/)/, HOME));
const config = () => ({
  sessions: envPath(
    "PI_CODING_AGENT_SESSION_DIR",
    join(HOME, ".pi/agent/sessions"),
  ),
  state: envPath(
    "AGENT_MEMORY_STATE_DIR",
    join(HOME, ".local/state/agent-memory"),
  ),
  data: envPath(
    "AGENT_MEMORY_DATA_DIR",
    join(HOME, ".local/share/agent-memory"),
  ),
  root: envPath(
    "AGENT_MEMORY_ROOT",
    join(HOME, "commonplace/01_files/_utilities/agent-memories"),
  ),
});
const MAX_SOURCE = 128 * 1024 * 1024;
const MAX_PROJECTION = 64 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contained(root: string, target: string): string {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const rel = relative(rootPath, targetPath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`path escapes ${rootPath}`);
  return targetPath;
}

function secureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function atomic(path: string, value: string): void {
  secureDir(dirname(path));
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.tmp`,
  );
  const fd = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(fd, value);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function walkJsonl(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const path = contained(root, join(root, item.name));
    if (item.isDirectory()) found.push(...walkJsonl(path));
    else if (item.isFile() && item.name.endsWith(".jsonl")) found.push(path);
  }
  return found.sort();
}

function parseStableSnapshot(source: string): Snapshot {
  const before = statSync(source);
  if (before.size > MAX_SOURCE) throw new Error("source exceeds size cap");
  const raw = readFileSync(source, "utf8");
  const after = statSync(source);
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ino !== after.ino
  )
    throw new Error("unstable read");
  const records: unknown[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      if (i === lines.length - 1 && !raw.endsWith("\n"))
        throw new Error("incomplete final jsonl record");
      throw new Error(`malformed jsonl line ${i + 1}`);
    }
  }
  const first = records[0];
  if (
    !object(first) ||
    first.type !== "session" ||
    typeof first.id !== "string" ||
    !first.id ||
    typeof first.cwd !== "string"
  )
    throw new Error("invalid session header");
  if (
    records
      .slice(1)
      .some((record) => object(record) && record.type === "session")
  )
    throw new Error("duplicate session header");
  const entries: Entry[] = [];
  const byId = new Map<string, Entry>();
  for (const record of records.slice(1)) {
    if (
      !object(record) ||
      typeof record.type !== "string" ||
      typeof record.id !== "string" ||
      !(record.parentId === null || typeof record.parentId === "string")
    )
      throw new Error("invalid entry shape");
    const entry = record as Entry;
    if (byId.has(entry.id)) throw new Error(`duplicate entry ${entry.id}`);
    byId.set(entry.id, entry);
    entries.push(entry);
  }
  for (const entry of entries)
    if (entry.parentId !== null && !byId.has(entry.parentId))
      throw new Error(`dangling parent ${entry.parentId}`);
  for (const entry of entries) {
    const seen = new Set<string>();
    let current: Entry | undefined = entry;
    while (current) {
      if (seen.has(current.id)) throw new Error(`cycle at ${current.id}`);
      seen.add(current.id);
      current =
        current.parentId === null ? undefined : byId.get(current.parentId);
    }
  }
  const parentIds = new Set(
    entries
      .map((entry) => entry.parentId)
      .filter((id): id is string => id !== null),
  );
  const leaves = entries
    .filter((entry) => !parentIds.has(entry.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const chains = leaves.map((leaf) => {
    const seen = new Set<string>();
    const chain: Entry[] = [];
    let current: Entry | undefined = leaf;
    while (current) {
      if (seen.has(current.id)) throw new Error(`cycle at ${current.id}`);
      seen.add(current.id);
      chain.unshift(current);
      current =
        current.parentId === null ? undefined : byId.get(current.parentId);
    }
    return chain;
  });
  if (entries.length > 0 && chains.length === 0)
    throw new Error("cyclic graph");
  return { source, header: first as Header, entries, chains };
}

function customData(
  entry: Entry,
  customType: string,
): Record<string, unknown> | undefined {
  if (
    entry.type !== "custom" ||
    entry.customType !== customType ||
    !object(entry.data)
  )
    return undefined;
  return entry.data;
}

function checkpoint(entry: Entry): Record<string, unknown> | undefined {
  const data = customData(entry, "@bds_pi/agent-memory/checkpoint");
  return data?.version === 1 &&
    typeof data.throughLeafId === "string" &&
    Number.isInteger(data.acceptedUserTurns) &&
    Number(data.acceptedUserTurns) >= 0
    ? data
    : undefined;
}

function visible(entry: Entry): string {
  if (entry.type !== "message" || !object(entry.message)) return "";
  const role = entry.message.role;
  if (role !== "user" && role !== "assistant") return "";
  const content = entry.message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(object)
            .filter(
              (part) => part.type === "text" && typeof part.text === "string",
            )
            .map((part) => part.text)
            .join("\n")
        : "";
  return text.trim() ? `### ${role}\n\n${text.trim()}` : "";
}

function latestSummary(
  chain: Entry[],
  through: string,
): { data: Record<string, unknown>; index: number } | undefined {
  let result: { data: Record<string, unknown>; index: number } | undefined;
  for (const [index, entry] of chain.entries()) {
    if (entry.id === through) break;
    const data = customData(entry, "@bds_pi/session-name/summary");
    if (
      data?.version === 1 &&
      typeof data.title === "string" &&
      typeof data.summary === "string" &&
      typeof data.throughLeafId === "string" &&
      chain.findIndex((candidate) => candidate.id === data.throughLeafId) >=
        0 &&
      chain.findIndex((candidate) => candidate.id === data.throughLeafId) <
        index
    )
      result = { data, index };
  }
  return result;
}

export function renderSnapshot(snapshot: Snapshot): {
  markdown: string;
  jobs: Job[];
} {
  const sections: string[] = [
    `# pi session ${snapshot.header.id}`,
    `workspace: ${snapshot.header.cwd}`,
  ];
  const jobs = new Map<string, Job>();
  for (const chain of snapshot.chains) {
    const leaf = chain.at(-1);
    if (!leaf) continue;
    let name = "";
    for (const entry of chain)
      if (entry.type === "session_info" && typeof entry.name === "string")
        name = entry.name;
    const checkpointEntries = chain.filter((entry, index) => {
      const data = checkpoint(entry);
      return (
        data !== undefined &&
        chain
          .slice(0, index)
          .some((candidate) => candidate.id === data.throughLeafId)
      );
    });
    const checkpointEntry = checkpointEntries.at(-1);
    const through = checkpointEntry
      ? String(checkpoint(checkpointEntry)?.throughLeafId)
      : leaf.id;
    const throughIndex = chain.findIndex((entry) => entry.id === through);
    const summary = latestSummary(chain, through);
    const bounded = chain.slice((summary?.index ?? -1) + 1, throughIndex + 1);
    const heading = `## branch ${leaf.id}${name ? ` — ${name}` : ""}`;
    const rendered = [
      heading,
      summary ? `### summary\n\n${String(summary.data.summary)}` : "",
      ...bounded.map(visible).filter(Boolean),
    ]
      .filter(Boolean)
      .join("\n\n");
    sections.push(rendered);
    for (const checkpointEntry of checkpointEntries)
      jobs.set(checkpointEntry.id, {
        version: 1,
        sessionId: snapshot.header.id,
        checkpointEntryId: checkpointEntry.id,
        sourcePath: snapshot.source,
        projectionPath: "",
        workspace: snapshot.header.cwd,
      });
  }
  let markdown = `${sections.join("\n\n")}\n`;
  if (Buffer.byteLength(markdown) > MAX_PROJECTION) {
    const prefix = `${sections.slice(0, 2).join("\n\n")}\n\n[earlier authored text truncated]\n\n`;
    const available = MAX_PROJECTION - Buffer.byteLength(prefix) - 1;
    const suffix = Buffer.from(sections.slice(2).join("\n\n"))
      .subarray(-available)
      .toString("utf8");
    markdown = `${prefix}${suffix}\n`;
  }
  return { markdown, jobs: [...jobs.values()] };
}

function lock<T>(fn: () => T): T | undefined {
  const { state } = config();
  secureDir(state);
  const path = contained(state, join(state, "mutating.lock"));
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner = 0;
    try {
      owner = Number(readFileSync(join(path, "owner"), "utf8"));
    } catch {}
    if (owner > 0) {
      try {
        process.kill(owner, 0);
        return undefined;
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code !== "ESRCH")
          return undefined;
      }
    } else if (Date.now() - statSync(path).mtimeMs < 60_000) return undefined;
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path, { mode: 0o700 });
  }
  writeFileSync(join(path, "owner"), `${process.pid}\n`, { mode: 0o600 });
  try {
    return fn();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

function projectUnlocked(): void {
  const cfg = config();
  const projectionDir = contained(cfg.data, join(cfg.data, "pi-sessions"));
  const pending = contained(cfg.data, join(cfg.data, "queue/pending"));
  const quarantine = contained(cfg.data, join(cfg.data, "quarantine"));
  [cfg.state, cfg.data, projectionDir, pending, quarantine].forEach(secureDir);
  for (const source of walkJsonl(cfg.sessions)) {
    try {
      const snapshot = parseStableSnapshot(source);
      const output = contained(
        projectionDir,
        join(projectionDir, `${snapshot.header.id}.md`),
      );
      const rendered = renderSnapshot(snapshot);
      atomic(output, rendered.markdown);
      for (const job of rendered.jobs) {
        job.projectionPath = output;
        const target = contained(
          pending,
          join(pending, `${job.sessionId}--${job.checkpointEntryId}.json`),
        );
        const done = contained(
          cfg.data,
          join(cfg.data, `queue/processed/${basename(target)}`),
        );
        const failed = contained(
          cfg.data,
          join(cfg.data, `queue/failed/${basename(target)}`),
        );
        if (!existsSync(target) && !existsSync(done) && !existsSync(failed))
          atomic(target, `${JSON.stringify(job)}\n`);
      }
    } catch (error) {
      const id = createHash("sha256").update(source).digest("hex").slice(0, 16);
      atomic(
        join(quarantine, `${id}.json`),
        `${JSON.stringify({ source, error: error instanceof Error ? error.message : String(error) })}\n`,
      );
      console.error(
        `${source}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function isJob(value: unknown): value is Job {
  return (
    object(value) &&
    value.version === 1 &&
    [
      "sessionId",
      "checkpointEntryId",
      "sourcePath",
      "projectionPath",
      "workspace",
    ].every((key) => typeof value[key] === "string")
  );
}

function run(
  binary: string,
  args: string[],
  input?: string,
  timeout = Number(process.env.AGENT_MEMORY_COMMAND_TIMEOUT_MS || 120_000),
): string {
  const result = spawnSync(binary, args, {
    cwd: HOME,
    input,
    encoding: "utf8",
    timeout,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.error || result.status !== 0)
    throw (
      result.error ||
      new Error(
        `${binary} exited ${result.status}: ${result.stderr.slice(0, 2000)}`,
      )
    );
  return result.stdout.slice(0, 256 * 1024);
}

function parseAction(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw.trim());
  if (!object(value) || (value.action !== "create" && value.action !== "skip"))
    throw new Error("model returned invalid action");
  if (value.action === "skip") return { action: "skip" };
  if (
    typeof value.title !== "string" ||
    value.title.length < 1 ||
    value.title.length > 120 ||
    !["preference", "decision", "gotcha", "pattern"].includes(
      String(value.kind),
    ) ||
    !Array.isArray(value.triggers) ||
    value.triggers.length > 20 ||
    !value.triggers.every((x) => typeof x === "string") ||
    !value.triggers.every((x) => x.length > 0 && x.length <= 200) ||
    !Array.isArray(value.keywords) ||
    value.keywords.length > 30 ||
    !value.keywords.every((x) => typeof x === "string") ||
    !value.keywords.every((x) => x.length > 0 && x.length <= 100) ||
    typeof value.body !== "string" ||
    value.body.length < 1 ||
    value.body.length > 8_000
  )
    throw new Error("model returned invalid candidate");
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "action,body,keywords,kind,title,triggers")
    throw new Error("model returned extra fields");
  return value;
}

type Candidate = {
  title: string;
  kind: string;
  scope: string;
  triggers: string[];
  keywords: string[];
  source: string;
  created: string;
  updated: string;
  body: string;
};

function parseCandidate(text: string): Candidate {
  const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]+)$/.exec(text);
  if (!match) throw new Error("invalid candidate frontmatter");
  const metadata = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    const field = /^([a-z]+):\s*(.*)$/.exec(line);
    if (!field || metadata.has(field[1]!))
      throw new Error("invalid candidate metadata");
    metadata.set(field[1]!, field[2]!);
  }
  const expected = [
    "created",
    "keywords",
    "kind",
    "scope",
    "source",
    "status",
    "title",
    "triggers",
    "updated",
    "version",
  ];
  if ([...metadata.keys()].sort().join(",") !== expected.join(","))
    throw new Error("invalid candidate fields");
  let title: unknown;
  let scope: unknown;
  let triggers: unknown;
  let keywords: unknown;
  try {
    title = JSON.parse(metadata.get("title")!);
    scope = JSON.parse(metadata.get("scope")!);
    triggers = JSON.parse(metadata.get("triggers")!);
    keywords = JSON.parse(metadata.get("keywords")!);
  } catch {
    throw new Error("invalid candidate metadata json");
  }
  const source = metadata.get("source")!;
  const created = metadata.get("created")!;
  const updated = metadata.get("updated")!;
  const body = match[2]!.trim();
  parseAction(
    JSON.stringify({
      action: "create",
      title,
      kind: metadata.get("kind"),
      triggers,
      keywords,
      body,
    }),
  );
  if (
    metadata.get("version") !== "1" ||
    metadata.get("status") !== "candidate" ||
    typeof scope !== "string" ||
    scope.length < 1 ||
    scope.length > 500 ||
    !/^pi:\/\/[^/]+\/[^/]+$/.test(source) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(created) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(updated)
  )
    throw new Error("invalid candidate values");
  return {
    title: title as string,
    kind: metadata.get("kind")!,
    scope,
    triggers: triggers as string[],
    keywords: keywords as string[],
    source,
    created,
    updated,
    body,
  };
}

function validateReceipt(path: string, jobId: string): void {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !object(value) ||
    Object.keys(value).sort().join(",") !== "action,createdAt,jobId,version" ||
    value.version !== 1 ||
    value.action !== "skip" ||
    value.jobId !== jobId ||
    typeof value.createdAt !== "string"
  )
    throw new Error("invalid skip receipt");
}

function scopeFor(workspace: string): string {
  const resolved = resolve(workspace);
  if (resolved === HOME) return "global";
  return resolved.startsWith(`${HOME}${sep}`)
    ? relative(HOME, resolved).split(sep).join("/")
    : "unknown";
}

function validateJob(job: Job): string {
  const snapshot = parseStableSnapshot(job.sourcePath);
  if (
    snapshot.header.id !== job.sessionId ||
    snapshot.header.cwd !== job.workspace
  )
    throw new Error("job source/header mismatch");
  const chain = snapshot.chains.find((item) =>
    item.some((entry) => entry.id === job.checkpointEntryId),
  );
  const entry = chain?.find((item) => item.id === job.checkpointEntryId);
  if (
    !chain ||
    !entry ||
    !checkpoint(entry) ||
    !chain
      .slice(
        0,
        chain.findIndex((item) => item.id === entry.id),
      )
      .some((item) => item.id === checkpoint(entry)?.throughLeafId)
  )
    throw new Error("checkpoint is not on branch ancestry");
  const checkpointIndex = chain.findIndex(
    (item) => item.id === job.checkpointEntryId,
  );
  const exactChain = chain.slice(0, checkpointIndex + 1);
  const rendered = renderSnapshot({
    ...snapshot,
    entries: exactChain,
    chains: [exactChain],
  }).markdown;
  return rendered.slice(0, MAX_PROJECTION);
}

function consolidateUnlocked(limit: number): boolean {
  const cfg = config();
  const dirs = {
    pending: join(cfg.data, "queue/pending"),
    processing: join(cfg.data, "queue/processing"),
    processed: join(cfg.data, "queue/processed"),
    failed: join(cfg.data, "queue/failed"),
    candidates: join(cfg.data, "candidates"),
    receipts: join(cfg.data, "receipts"),
  };
  Object.values(dirs).forEach(secureDir);
  for (const name of readdirSync(dirs.processing))
    if (
      statSync(join(dirs.processing, name)).mtimeMs <
      Date.now() - 15 * 60_000
    )
      renameSync(join(dirs.processing, name), join(dirs.pending, name));
  let externalFailure = false;
  for (const name of readdirSync(dirs.pending)
    .filter((x) => x.endsWith(".json"))
    .sort()
    .slice(0, limit)) {
    const processing = join(dirs.processing, name);
    renameSync(join(dirs.pending, name), processing);
    let externalStarted = false;
    try {
      const parsed: unknown = JSON.parse(readFileSync(processing, "utf8"));
      if (!isJob(parsed)) throw new Error("invalid job schema");
      const job = parsed;
      const key = basename(name, ".json");
      const candidatePath = join(dirs.candidates, `${key}.md`);
      const receiptPath = join(dirs.receipts, `${key}.json`);
      if (existsSync(candidatePath) && existsSync(receiptPath))
        throw new Error("candidate and skip receipt both exist");
      if (existsSync(candidatePath)) {
        const candidate = parseCandidate(readFileSync(candidatePath, "utf8"));
        if (
          candidate.source !== `pi://${job.sessionId}/${job.checkpointEntryId}`
        )
          throw new Error("candidate source does not match job");
      } else if (existsSync(receiptPath)) validateReceipt(receiptPath, key);
      else {
        const projection = validateJob(job);
        externalStarted = true;
        const qmd = process.env.QMD_BIN || "qmd";
        const search =
          process.env.AGENT_MEMORY_SKIP_EXTERNAL === "1"
            ? "[]"
            : run(qmd, [
                "search",
                "-c",
                "agent-memories",
                "--json",
                `${job.workspace} ${projection.slice(-1000)}`,
              ]).slice(0, 32_000);
        const prompt = `return exactly one json object. create only durable memory; otherwise skip. create schema: {"action":"create","title":"","kind":"preference|decision|gotcha|pattern","triggers":[],"keywords":[],"body":""}. skip schema: {"action":"skip"}.\n\nsession:\n${projection.slice(-48_000)}\n\nexisting bounded search:\n${search}`;
        const response =
          process.env.AGENT_MEMORY_SKIP_EXTERNAL === "1"
            ? '{"action":"skip"}'
            : run(
                process.env.PI_BIN || "pi",
                [
                  "-p",
                  "--no-session",
                  "--no-tools",
                  "--no-extensions",
                  "--no-skills",
                  "--no-prompt-templates",
                  "--no-context-files",
                  "--model",
                  process.env.AGENT_MEMORY_MODEL ||
                    "openai-codex/gpt-5.6-luna:low",
                ],
                prompt,
              );
        const action = parseAction(response);
        const now = new Date().toISOString();
        if (action.action === "skip")
          atomic(
            receiptPath,
            `${JSON.stringify({ version: 1, action: "skip", jobId: key, createdAt: now })}\n`,
          );
        else
          atomic(
            candidatePath,
            `---\nversion: 1\nstatus: candidate\ntitle: ${JSON.stringify(action.title)}\nkind: ${String(action.kind)}\nscope: ${JSON.stringify(scopeFor(job.workspace))}\ntriggers: ${JSON.stringify(action.triggers)}\nkeywords: ${JSON.stringify(action.keywords)}\nsource: pi://${job.sessionId}/${job.checkpointEntryId}\ncreated: ${now.slice(0, 10)}\nupdated: ${now.slice(0, 10)}\n---\n\n${String(action.body)}\n`,
          );
      }
      renameSync(processing, join(dirs.processed, name));
    } catch (error) {
      console.error(
        `${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (externalStarted) {
        externalFailure = true;
        renameSync(processing, join(dirs.pending, name));
      } else renameSync(processing, join(dirs.failed, name));
    }
  }
  return !externalFailure;
}

function reconcile(): void {
  const cfg = config();
  secureDir(cfg.data);
  const files = existsSync(cfg.root)
    ? readdirSync(cfg.root)
        .filter(
          (name) => name.endsWith(".md") && name.includes("source__agent"),
        )
        .sort()
    : [];
  const records = files.map((name) => {
    const text = readFileSync(
      contained(cfg.root, join(cfg.root, name)),
      "utf8",
    );
    const title = (
      /^title:\s*(.+)$/im.exec(text)?.[1] ||
      /^#\s+(.+)$/m.exec(text)?.[1] ||
      basename(name, ".md")
    )
      .trim()
      .replace(/^['"]|['"]$/g, "");
    const metadata = Object.fromEntries(
      ["title", "kind", "scope", "source", "created", "updated"].map((key) => [
        key,
        new RegExp(`^${key}:`, "im").test(text),
      ]),
    );
    return {
      file: name,
      title,
      normalizedTitle: title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim(),
      scope: /^scope:\s*(.+)$/im.exec(text)?.[1]?.trim() || "unknown",
      metadata,
    };
  });
  const duplicates = [
    ...new Set(
      records
        .map((record) => record.normalizedTitle)
        .filter(
          (title) =>
            records.filter((record) => record.normalizedTitle === title)
              .length > 1,
        ),
    ),
  ]
    .sort()
    .map((title) => ({
      title,
      files: records
        .filter((record) => record.normalizedTitle === title)
        .map((record) => record.file),
    }));
  atomic(
    join(cfg.data, "reconcile-report.json"),
    `${JSON.stringify({ version: 1, duplicates, memories: records }, null, 2)}\n`,
  );
  const topOfMind = records
    .slice()
    .reverse()
    .slice(0, 20)
    .map((record) => `- ${record.title} — ${record.file}`)
    .join("\n");
  atomic(
    join(cfg.data, "top-of-mind.md"),
    `<!-- agent-memory:top-of-mind:start -->\n# top of mind\n\n${topOfMind}\n<!-- agent-memory:top-of-mind:end -->\n`,
  );
}

function maintainUnlocked(): boolean {
  const cfg = config();
  projectUnlocked();
  secureDir(cfg.state);
  const gatesPath = join(cfg.state, "maintain-gates.json");
  let gates: { consolidation?: number; qmd?: number; reconcile?: number } = {};
  try {
    gates = JSON.parse(readFileSync(gatesPath, "utf8"));
  } catch {}
  const now = Date.now();
  let ok = true;
  if (now - (gates.consolidation || 0) >= 2 * 60 * 60_000) {
    ok = consolidateUnlocked(
      Number(process.env.AGENT_MEMORY_MAINTAIN_LIMIT || 10),
    );
    if (ok) gates.consolidation = now;
  }
  if (process.env.AGENT_MEMORY_SKIP_EXTERNAL !== "1") {
    try {
      run(process.env.QMD_BIN || "qmd", ["update"]);
    } catch {
      ok = false;
    }
    if (now - (gates.qmd || 0) >= 2 * 60 * 60_000)
      try {
        const timeout = Number(
          process.env.AGENT_MEMORY_EMBED_TIMEOUT_MS || 15 * 60_000,
        );
        run(
          process.env.QMD_BIN || "qmd",
          ["embed", "-c", "pi-sessions"],
          undefined,
          timeout,
        );
        run(
          process.env.QMD_BIN || "qmd",
          ["embed", "-c", "agent-memories"],
          undefined,
          timeout,
        );
        gates.qmd = now;
      } catch {
        ok = false;
      }
  }
  if (now - (gates.reconcile || 0) >= 24 * 60 * 60_000) {
    reconcile();
    gates.reconcile = now;
  }
  atomic(gatesPath, `${JSON.stringify(gates)}\n`);
  return ok;
}

function promote(candidate: string): void {
  const cfg = config();
  const candidates = join(cfg.data, "candidates");
  const source = contained(
    candidates,
    isAbsolute(candidate) ? candidate : join(candidates, candidate),
  );
  const text = readFileSync(source, "utf8");
  const parsed = parseCandidate(text);
  const slug =
    parsed.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "memory";
  const identity = createHash("sha256")
    .update(parsed.source)
    .digest("hex")
    .slice(0, 12);
  secureDir(cfg.root);
  const destination = contained(
    cfg.root,
    join(cfg.root, `${parsed.created}-${slug}-${identity}--source__agent.md`),
  );
  const promoted = text.replace(/^status: candidate$/m, "status: active");
  const promotionReceipts = contained(
    cfg.data,
    join(cfg.data, "promotion-receipts"),
  );
  secureDir(promotionReceipts);
  const receipt = contained(
    promotionReceipts,
    join(promotionReceipts, `${identity}.json`),
  );
  if (existsSync(destination)) {
    if (readFileSync(destination, "utf8") !== promoted)
      throw new Error("active memory identity collision");
  } else {
    const fd = openSync(
      destination,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      writeFileSync(fd, promoted);
    } finally {
      closeSync(fd);
    }
    chmodSync(destination, 0o600);
  }
  const receiptValue = `${JSON.stringify({ version: 1, source: parsed.source, destination: basename(destination), sha256: createHash("sha256").update(promoted).digest("hex") })}\n`;
  if (existsSync(receipt) && readFileSync(receipt, "utf8") !== receiptValue)
    throw new Error("promotion receipt collision");
  if (!existsSync(receipt)) atomic(receipt, receiptValue);
  if (process.env.AGENT_MEMORY_SKIP_EXTERNAL !== "1")
    run(process.env.QMD_BIN || "qmd", ["update"]);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  let result: boolean | undefined = true;
  if (command === "project")
    result = lock(() => {
      projectUnlocked();
      return true;
    });
  else if (command === "consolidate") {
    const index = args.indexOf("--limit");
    const limit = index >= 0 ? Number(args[index + 1]) : 10;
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000)
      throw new Error("invalid --limit");
    result = lock(() => consolidateUnlocked(limit));
  } else if (command === "reconcile")
    result = lock(() => {
      reconcile();
      return true;
    });
  else if (command === "maintain") result = lock(maintainUnlocked);
  else if (command === "promote" && args[0])
    result = lock(() => {
      promote(args[0]!);
      return true;
    });
  else
    throw new Error(
      "usage: agent-memory project|consolidate [--limit N]|reconcile|maintain|promote <candidate>",
    );
  if (result === false) process.exitCode = 1;
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const header = { type: "session" as const, id: "s", cwd: "/tmp" };
  const message = (
    id: string,
    parentId: string | null,
    role: string,
    content: unknown,
  ): Entry => ({ type: "message", id, parentId, message: { role, content } });
  describe("session projection invariants", () => {
    it("projects only authored text", () => {
      const snapshot: Snapshot = {
        source: "/tmp/s",
        header,
        entries: [],
        chains: [
          [
            message("u", null, "user", [{ type: "text", text: "visible" }]),
            message("a", "u", "assistant", [
              { type: "thinking", thinking: "secret" },
              { type: "toolCall", name: "bash" },
              { type: "text", text: "answer" },
            ]),
            message("t", "a", "toolResult", "leak"),
          ],
        ],
      };
      expect(renderSnapshot(snapshot).markdown).toContain("visible");
      expect(renderSnapshot(snapshot).markdown).toContain("answer");
      expect(renderSnapshot(snapshot).markdown).not.toMatch(/secret|bash|leak/);
    });
    it("uses checkpoint identity for deterministic jobs", () => {
      const cp: Entry = {
        type: "custom",
        customType: "@bds_pi/agent-memory/checkpoint",
        data: { version: 1, throughLeafId: "u", acceptedUserTurns: 1 },
        id: "cp",
        parentId: "u",
      };
      const snapshot: Snapshot = {
        source: "/tmp/s",
        header,
        entries: [],
        chains: [[message("u", null, "user", "hi"), cp]],
      };
      expect(renderSnapshot(snapshot).jobs).toEqual(
        renderSnapshot(snapshot).jobs,
      );
      expect(renderSnapshot(snapshot).jobs[0]?.checkpointEntryId).toBe("cp");
    });

    it("queues every checkpoint on a branch", () => {
      const first: Entry = {
        type: "custom",
        customType: "@bds_pi/agent-memory/checkpoint",
        data: { version: 1, throughLeafId: "u1", acceptedUserTurns: 1 },
        id: "cp1",
        parentId: "u1",
      };
      const second: Entry = {
        type: "custom",
        customType: "@bds_pi/agent-memory/checkpoint",
        data: { version: 1, throughLeafId: "u2", acceptedUserTurns: 2 },
        id: "cp2",
        parentId: "u2",
      };
      const chain = [
        message("u1", null, "user", "one"),
        first,
        message("u2", "cp1", "user", "two"),
        second,
      ];
      const snapshot: Snapshot = {
        source: "/tmp/s",
        header,
        entries: chain,
        chains: [chain],
      };
      expect(
        renderSnapshot(snapshot).jobs.map((job) => job.checkpointEntryId),
      ).toEqual(["cp1", "cp2"]);
    });

    it("keeps the newest authored text when a projection is truncated", () => {
      const chain = [
        message("u1", null, "user", `old-start ${"x".repeat(MAX_PROJECTION)}`),
        message("a1", "u1", "assistant", "newest-checkpoint-result"),
        {
          type: "custom",
          customType: "@bds_pi/agent-memory/checkpoint",
          data: { version: 1, throughLeafId: "a1", acceptedUserTurns: 1 },
          id: "cp",
          parentId: "a1",
        },
      ];
      const markdown = renderSnapshot({
        source: "/tmp/s",
        header,
        entries: chain,
        chains: [chain],
      }).markdown;
      expect(markdown).toContain("[earlier authored text truncated]");
      expect(markdown).toContain("newest-checkpoint-result");
      expect(markdown).not.toContain("old-start");
    });

    it("strictly validates durable-memory candidates", () => {
      const candidate = `---\nversion: 1\nstatus: candidate\ntitle: "durable preference"\nkind: preference\nscope: "global"\ntriggers: ["when choosing tools"]\nkeywords: ["tools"]\nsource: pi://session/checkpoint\ncreated: 2026-07-19\nupdated: 2026-07-19\n---\n\nprefer the existing tool.\n`;
      expect(parseCandidate(candidate)).toMatchObject({
        title: "durable preference",
        source: "pi://session/checkpoint",
      });
      expect(() =>
        parseCandidate(candidate.replace("version: 1", "version: 2")),
      ).toThrow("invalid candidate values");
    });
  });
}
