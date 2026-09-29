# agent guidance maintenance

`config/global-agents.md` is the canonical personal policy. `skills/` is the
portable collection copied by home-manager and projected to remote agent
repositories. keep installation code and test infrastructure outside `skills/`.

## verification

from the repository root:

```bash
node --experimental-strip-types modules/agents/check-skills.ts
node --experimental-strip-types --test modules/agents/check-skills.test.ts \
  modules/agents/evaluate-skill-routing.test.ts
(cd modules/pi && pnpm exec tsc -p ../agents/tsconfig.json)
```

these use the SDK installed under `modules/pi`; run its normal dependency setup
if unavailable, not an ad-hoc global install. static checks validate discovery
and consumed entrypoint references, not model behavior. internal archival-source
links warn by default; `--all-document-links` audits them without rewriting
captured evidence. entrypoint links outside the portable skill collection fail.

when descriptions change, retain positive, negative, and overlapping cases in
`skill-cases.json`. if model invocation is authorized:

```bash
node --experimental-strip-types modules/agents/evaluate-skill-routing.ts --live
```

the runner uses existing Codex OAuth, no session history, and fresh contexts.
it records model-emitted choices without executing tools. selection success
does not establish skill-body compliance or productivity. do not put expected
answers in candidate prompts or relabel failures as passes.

for the darwin case-normalization activation hook:

```bash
node --experimental-strip-types --test modules/agents/test-skill-case-repair.test.ts
```

this evaluates the real hook and runs it only against temporary homes. verify
the affected host derivation and build its home-manager activation package per
the repository's nix policy. do not activate the real home merely to test.

git-backed flakes omit untracked new skills. before staging is authorized, a
verification-only `extendModules` override of
`home.file.".config/agents/skills".source` with `builtins.path` pointing to the
local `skills/` directory can exercise the complete working-tree collection.
inspect discovery/bytes in the resulting artifact; do not claim an ordinary
git-backed build included an untracked skill.
