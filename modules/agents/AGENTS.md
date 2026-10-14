# agent guidance maintenance

`config/global-agents.md` is the canonical personal policy. `skills/` is the
portable collection, linked live into each agent's skills directory.
external skills are vendored here; skills that programs write show up as
untracked files to commit or discard. keep installation code and test
infrastructure outside `skills/`.

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

installed agents read the live checkout, so skill edits need no nix build.
`default.nix` wiring changes still need host evaluation and a home-manager
activation package build per the repository's nix policy.
