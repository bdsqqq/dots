# automatic memory: reduce the integration, preserve the decision

assessment of `cd36d8b88ef5adcdb21a5ac2a4ce3443ae6e9722`; source only, 2026-10-17.

**recommendation (HUNCH):** prefer explicit guidance plus deliberate search as the
baseline; automatic injection, exposure receipts and reflection have not earned
retention merely by existing. keep accepted memories and governance intact.
the user's “agent memory is… weird, on the “rethink if i even need it” bucket”
is a question, NOT removal authority ([direction](../../../simplification-direction.md):102–110,201–203).
parent can close P4 as an assessment, not as memory retirement.

## what is coupled today

VERIFIED means traced source behavior, not a running-host observation.
coordinates below are relative to this directory unless stated otherwise.

| surface / consumer | traced effects and boundary |
| --- | --- |
| pi extension: prompt adapter | [extension](../../extensions/agent-memory/index.ts):524–663,1950–1989 prepares/resumes a frozen session snapshot, copies hash-bound artifacts, injects selected bodies and external pointers plus project-proposal instructions; snapshot failure can roll back the local tier manifest. |
| pi extension: retrieval tools | extension:1690–1899 wraps qmd search, filters current non-quarantined catalog entries, reorders candidates and validates hashes on open; logs retrieval metadata. extension:1902–1947 blocks generic `read`/`grep` at the memory root and validates tool results. this is not a shell-access security boundary. |
| pi extension: producer | extension:1227–1432,1662–1687,1992–2079 appends injection/exposure/outcome receipts and checkpoints to native sessions; :1435–1448,1503–1535,2128–2151 publishes delayed/shutdown maintenance demand and flushes logs. exposure/citation is not evidence of usefulness. |
| background source reconciler | [runtime](maintainer/runtime.ts):200–214,234–311 discovers pi roots and staged Amp sessions, reconciles source records, schedules reflection. [sources](maintainer/sources.ts):758–843,846–904 validates branch receipts and writes bounded session projections/graph artifacts; absent checkpoints, it uses the branch leaf. removing the extension alone does NOT stop ingestion. |
| reflection and admission | runtime:350–355,448–498,955–1195,1531–1557 sends source evidence/catalog to a model, routes project suggestions separately, admits personal-memory candidates and publishes accepted output. skill drafts cannot use this admission path. [history](maintainer/history.ts):1115–1177 checks basis, pushes candidate commits, confirms remote acceptance and materializes canonical state. |
| indexing / maintenance | runtime:1302–1359,1362–1527 writes diagnostics, creates maintenance proposals, syncs history, publishes verified qmd content, runs `qmd update`/`embed`, and conditionally cleans local artifacts. [retention](maintainer/retention.ts):31–51 excludes canonical history from local cleanup. these are not just tool UI effects. |
| host consumers | [pi-memory wiring](../../../../pi-memory/default.nix):7–25,33–72 launches the live CLI hourly and on demand on Darwin/Linux; enables cleanup and configures model/remote. [qmd wiring](../../../../node-pnpm/default.nix):60–71 indexes only the accepted projection. source configuration is not proof a service is currently running. |

## separate the choices

**VERIFIED:** session history is evidence, not admitted personal memory.
source projections above are generated caches; [projection](maintainer/projection.ts):154–184,194–235
publishes/validates catalog-bound Markdown from an audited accepted head.
native session discovery/read helps deliberate history lookup, not admission.
never search raw sessions as fallback personal memory.

**VERIFIED counterevidence to “just use qmd”:** manual
`qmd search -c agent-memories "KEYWORDS" -n 10` can reuse that collection without
prompt injection, but is not equivalent to the extension's quarantine filtering,
hash validation, redaction, ordering or receipts (extension:512–521,1690–1899).
native reads of unrelated notes do not inherit governed-memory guarantees.
existing explicit guidance can carry stable preferences; it cannot discover an
unstated preference by itself. manual search still depends on index freshness.

| option | smallest next step; trade-off |
| --- | --- |
| keep temporarily | change nothing while the user decides; preserves behavior and ongoing operational costs/side effects, not evidence that those costs pay off. |
| reduce — recommended direction | with separate approval, compare explicit guidance + manual accepted-projection search against injection; retain governed storage/publication. choose retrieval guards independently from prompt/receipt UI. no replacement framework. |
| retire automatic integration | requires explicit approval and consumer tracing for extension, producer, reflection, indexing and services separately. retaining searchable accepted notes still needs a freshness path; retiring all maintenance is a larger choice, not implied by retiring UI. |

**QUESTION — user choice:** should automatic recall continue at all? if not,
should background capture/reflection also stop, or only unsolicited prompt use?
no configuration, auth, service, canonical-data or installed-skill changes follow
from this assessment. the CLI also exposes manual propose/review/history paths
([index](index.ts):131–208); those are separate from extension registration.

## what would change the recommendation

an approved, bounded comparison on real tasks: same explicit guidance, with
manual retrieval versus automatic context; identify avoided repeated corrections,
missed relevant memories, stale/irrelevant injections, privacy surprises, and
prompt/model/maintenance cost. user judgment of useful changed outcomes matters.
consistent benefit beyond deliberate search would falsify the reduction HUNCH.
receipts establish exposure, not causal benefit; fixture tests establish behavior
invariants, not personal usefulness. no such outcome evidence was collected here.

verification: traced the cited paths and challenged extension-only retirement
against the leaf fallback and independent supervisor. no private memories/raw
personal sessions read; no model/service probes. Markdown parsing/local links
checked separately; runtime behavior, live service state and usefulness remain
unverified. parent should preserve this unresolved product choice in P4/P5.
