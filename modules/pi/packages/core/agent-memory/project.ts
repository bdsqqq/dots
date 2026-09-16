import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { scanCatalog, type MemoryConfig } from "./catalog.js";
import { canonicalProposalId, type Proposal } from "./schema.js";
import { parseStoredProposal } from "./workflow.js";
import { canonicalJson, sha256, v3Data, type JsonValue } from "./maintainer/common.js";
import { unsafeCanonicalValue } from "./maintainer/admission.js";
import type { HistoryConfig } from "./maintainer/history.js";

const LIMIT = 1_048_576;

export class ProjectProposalTransportError extends Error {}

function git(args: string[], input?: string): string {
  const result = spawnSync("git", ["-c", "commit.gpgSign=false", ...args], {
    input,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: LIMIT * 2,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "pi memory",
      GIT_AUTHOR_EMAIL: "pi-memory@localhost",
      GIT_COMMITTER_NAME: "pi memory",
      GIT_COMMITTER_EMAIL: "pi-memory@localhost",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    },
  });
  if (result.status !== 0) throw new Error("project proposal git operation failed");
  return result.stdout.trim();
}

/** Repository identity is portable across clones; credentials and local paths are not. */
export function normalizeRepositoryId(remote: string): string | null {
  try {
    const scp = /^(?:[^/@:]+@)?([^/:]+):(.+)$/.exec(remote);
    const url = new URL(
      !remote.includes("://") && scp
        ? `ssh://${scp[1]}/${scp[2]}`
        : remote,
    );
    if (!["https:", "ssh:"].includes(url.protocol) || url.port || url.search || url.hash)
      return null;
    const path = url.pathname.replace(/^\/|\/$/g, "").replace(/\.git$/, "");
    if (!path || !/^[A-Za-z0-9._/-]+$/.test(path) ||
        path.split("/").some((part) => !part || part === "." || part === ".."))
      return null;
    return `${url.hostname.toLowerCase()}/${path}`;
  } catch {
    return null;
  }
}

export function projectRepositoryId(workspace: string): string | null {
  try {
    return normalizeRepositoryId(git(["-C", workspace, "remote", "get-url", "origin"]));
  } catch {
    return null;
  }
}

/** Scope determines ownership; an unavailable repository never becomes personal memory. */
export function routeProposal(cfg: MemoryConfig, proposal: Proposal): Proposal {
  if (proposal.lane !== "memory") return proposal;
  const operation = proposal.operation;
  const catalog = scanCatalog(cfg.root);
  const scopes: string[] = [];
  if ("artifact" in operation) scopes.push(operation.artifact.scope);
  for (const ref of [
    ...("target" in operation ? [operation.target] : []),
    ...("primary" in operation ? [operation.primary] : []),
    ...("targets" in operation ? operation.targets : []),
  ]) {
    const entry = catalog.entries.find((entry) =>
      entry.memoryId === ref.memoryId && entry.path === ref.path);
    if (!entry) throw new Error("project routing target is unavailable");
    scopes.push(entry.scope);
  }
  if (!scopes.length || new Set(scopes).size !== 1)
    throw new Error("proposal mixes knowledge owners");
  const personal = scopes[0] === "global";
  if (proposal.destination) {
    if ((proposal.destination.type === "personal") !== personal)
      throw new Error("proposal destination contradicts scope");
    if (proposal.destination.type === "project") {
      const observed = projectRepositoryId(scopes[0]!);
      if (observed && observed !== proposal.destination.repositoryId)
        throw new Error("proposal repository identity changed");
    }
    return proposal;
  }
  const { id: _id, ...rest } = proposal;
  const identity: Omit<Proposal, "id"> = {
    ...rest,
    digestVersion: 2,
    destination: personal
      ? { type: "personal" }
      : { type: "project", repositoryId: projectRepositoryId(scopes[0]!) },
  };
  return { ...identity, id: canonicalProposalId(identity) };
}

function store(cfg: Pick<MemoryConfig, "data">): string {
  const path = v3Data(cfg, "project-proposals.git");
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    git(["init", "--bare", path]);
  }
  return path;
}

function prefix(repositoryId: string): string {
  return `refs/pi-memory/projects/${sha256(repositoryId)}`;
}

function resolutionPrefix(repositoryId: string): string {
  return `refs/pi-memory/project-resolutions/${sha256(repositoryId)}`;
}

/** A disposition records agent work, not permission to make that work or proof of correctness. */
export function resolveProjectProposal(
  cfg: HistoryConfig,
  workspace: string,
  proposalId: string,
  reason: string,
): void {
  const repositoryId = projectRepositoryId(workspace);
  if (!repositoryId || !/^prop_[a-f0-9]{32}$/.test(proposalId) ||
      !reason.trim() || reason.length > 1000 || unsafeCanonicalValue(reason))
    throw new Error("invalid project proposal disposition");
  const proposals = listProjectProposals(cfg, workspace, true, true);
  if (!proposals.some((proposal) => proposal.id === proposalId))
    throw new Error("project proposal is not available for this repository");
  const raw = canonicalJson({ repositoryId, proposalId, reason });
  const directory = store(cfg);
  const run = (args: string[], input?: string) => git(["--git-dir", directory, ...args], input);
  const blob = run(["hash-object", "-w", "--stdin"], raw);
  const tree = run(["mktree"], `100644 blob ${blob}\tdisposition.json\n`);
  const commit = run(["commit-tree", tree], `resolve ${proposalId}\n`);
  run(["push", cfg.remote,
    `${commit}:${resolutionPrefix(repositoryId)}/${proposalId}/${sha256(raw)}`]);
}

/**
 * Each proposal owns an immutable remote ref: disjoint writers never contend.
 * These refs carry suggestions, not accepted facts or authority to edit a repo.
 */
export function publishProjectProposal(cfg: HistoryConfig, proposal: Proposal): void {
  const parsed = parseStoredProposal(JSON.stringify(proposal));
  if (parsed.destination?.type !== "project" || !parsed.destination.repositoryId)
    throw new Error("project proposal has no portable repository identity");
  const raw = canonicalJson(parsed as unknown as JsonValue);
  if (unsafeCanonicalValue(raw) ||
      parsed.evidence.some((entry) => sha256(entry.excerpt) !== entry.excerptSha256))
    throw new Error("unsafe project proposal or invalid evidence");
  if (Buffer.byteLength(raw) > LIMIT) throw new Error("project proposal exceeds limit");
  const directory = store(cfg);
  const run = (args: string[], input?: string) => git(["--git-dir", directory, ...args], input);
  const blob = run(["hash-object", "-w", "--stdin"], raw);
  const tree = run(["mktree"], `100644 blob ${blob}\tproposal.json\n`);
  const commit = run(["commit-tree", tree], `${parsed.id}\n`);
  const ref = `${prefix(parsed.destination.repositoryId)}/${parsed.id}`;
  // Deterministic content and commit metadata make an uncertain push replay identical.
  try {
    run(["push", cfg.remote, `${commit}:${ref}`]);
  } catch {
    throw new ProjectProposalTransportError("project proposal publication unavailable");
  }
}

export function listProjectProposals(
  cfg: HistoryConfig,
  workspace: string,
  synchronize = false,
  includeResolved = false,
): Proposal[] {
  const repositoryId = projectRepositoryId(workspace);
  if (!repositoryId) return [];
  const directory = store(cfg);
  const run = (args: string[]) => git(["--git-dir", directory, ...args]);
  const root = prefix(repositoryId);
  if (synchronize)
    run(["fetch", "--no-tags", cfg.remote, `${root}/*:${root}/*`,
      `${resolutionPrefix(repositoryId)}/*:${resolutionPrefix(repositoryId)}/*`]);
  const resolved = new Set<string>();
  if (!includeResolved) {
    const receipts = run(["for-each-ref", "--format=%(refname)", resolutionPrefix(repositoryId)])
      .split("\n").filter(Boolean);
    if (receipts.length > 1000) throw new Error("project disposition queue exceeds bounded read limit");
    for (const ref of receipts) {
      const raw = run(["show", `${ref}:disposition.json`]);
      const receipt = JSON.parse(raw) as { repositoryId: string; proposalId: string; reason: string };
      if (receipt.repositoryId !== repositoryId ||
          !/^prop_[a-f0-9]{32}$/.test(receipt.proposalId) ||
          typeof receipt.reason !== "string" || !receipt.reason.trim() ||
          ref !== `${resolutionPrefix(repositoryId)}/${receipt.proposalId}/${sha256(raw)}`)
        throw new Error("project disposition identity mismatch");
      resolved.add(receipt.proposalId);
    }
  }
  const refs = run(["for-each-ref", "--format=%(refname)", root]).split("\n").filter(Boolean);
  if (refs.length > 1000) throw new Error("project proposal queue exceeds bounded read limit");
  return refs.map((ref) => {
    const raw = run(["show", `${ref}:proposal.json`]);
    if (Buffer.byteLength(raw) > LIMIT) throw new Error("project proposal exceeds limit");
    const proposal = parseStoredProposal(raw);
    if (
      proposal.destination?.type !== "project" ||
      proposal.destination.repositoryId !== repositoryId ||
      ref !== `${root}/${proposal.id}`
    )
      throw new Error("project proposal identity mismatch");
    return proposal;
  }).filter((proposal) => !resolved.has(proposal.id));
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  function fixtureProposal(scope: string, title: string): Proposal {
    const value: Omit<Proposal, "id"> = {
      version: 2,
      digestVersion: 2,
      lane: "memory",
      status: "pending",
      operation: {
        type: "create",
        artifact: {
          memoryId: `mem_${sha256(title).slice(0, 24)}`,
          title,
          kind: "gotcha",
          scope,
          description: "Use when testing project knowledge",
          triggers: ["project verification"],
          keywords: ["project"],
          sources: ["pi://test/entry"],
          created: "2026-09-15",
          updated: "2026-09-15",
          body: "Run the repository verification before changing behavior.",
        },
      },
      supersedes: [],
      evidence: [],
      provenance: {
        runId: "run_project_test",
        promptVersion: 2,
        model: "test",
        createdAt: "2026-09-15T00:00:00.000Z",
        corpusAware: true,
        autonomous: true,
      },
    };
    return { ...value, id: canonicalProposalId(value) };
  }
  describe("project identity", () => {
    it("matches ssh and https clones without retaining credentials", () => {
      expect(normalizeRepositoryId("git@github.com:owner/repo.git"))
        .toBe("github.com/owner/repo");
      expect(normalizeRepositoryId("https://user:password@github.com/owner/repo.git"))
        .toBe("github.com/owner/repo");
    });
    it("does not guess identities for local paths or ambiguous urls", () => {
      for (const value of ["/tmp/repo", "file:///repo", "https://host/repo?branch=x"])
        expect(normalizeRepositoryId(value)).toBeNull();
    });

    it("routes personal and project knowledge and converges across independent hosts", () => {
      const base = mkdtempSync(`${tmpdir()}/pi-project-`);
      try {
        const remote = join(base, "remote.git");
        git(["init", "--bare", remote]);
        const root = join(base, "canonical");
        mkdirSync(root);
        const a = { data: join(base, "a"), root, state: join(base, "a-state"), remote, skillsRoot: join(base, "skills") };
        const b = { ...a, data: join(base, "b") };
        const workspace = join(base, "work-a");
        const clone = join(base, "work-b");
        for (const path of [workspace, clone]) {
          git(["init", path]);
          git(["-C", path, "remote", "add", "origin", "git@example.com:team/project.git"]);
        }
        expect(routeProposal(a, fixtureProposal("global", "personal")).destination)
          .toEqual({ type: "personal" });
        const first = routeProposal(a, fixtureProposal(workspace, "project one"));
        const second = routeProposal(b, fixtureProposal(clone, "project two"));
        expect(first.destination).toEqual({ type: "project", repositoryId: "example.com/team/project" });
        expect(parseStoredProposal(JSON.stringify(first))).toEqual(first);
        expect(() => parseStoredProposal(JSON.stringify({
          ...first, destination: { type: "personal" },
        }))).toThrow();
        publishProjectProposal(a, first);
        publishProjectProposal(b, second);
        publishProjectProposal(a, first);
        expect(() => publishProjectProposal(
          { ...a, remote: join(base, "offline.git") }, first,
        )).toThrow(ProjectProposalTransportError);
        expect(listProjectProposals(b, clone, true).map((p) => p.id).sort())
          .toEqual([first.id, second.id].sort());
        resolveProjectProposal(a, workspace, first.id, "incorporated in repository tests");
        expect(listProjectProposals(b, clone, true).map((p) => p.id)).toEqual([second.id]);
        expect(listProjectProposals(b, clone, false, true)).toHaveLength(2);
        git(["-C", clone, "remote", "set-url", "origin", "https://example.com/other/project"]);
        expect(listProjectProposals(b, clone, true)).toEqual([]);
        expect(routeProposal(a, fixtureProposal(join(base, "missing"), "unresolved")).destination)
          .toEqual({ type: "project", repositoryId: null });
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });
}
