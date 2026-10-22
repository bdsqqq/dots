# session-review vocabulary

working vocabulary discovered from 60 native sessions across engineering, admin
and everyday life. use it to organize evidence for later insight, not as personal
preferences or an exhaustive allowlist. narrower leaves often came from one long
workstream; depth does not establish recurrence. note genuinely new themes rather
than forcing them into these names.

work tags describe the subject/mechanism. collaboration tags describe what
happened between user and agent. inferred lessons and proposed interventions are
separate from both. parent paths collect their narrower meanings; don't apply
both ancestor and descendant just to inflate a result.

## work

### agents

- `agents/direction`: what the agent environment should be responsible for.
- `agents/context`: trees, branches, compaction and handoffs.
- `agents/delegation`: work distribution, child identity, progress and ownership.
- `agents/attention`: monitoring responsibilities and meaningful waiting/waking.
- `agents/continuity`: executable continuation across hosts or interruption.
- `agents/history`: transcript preservation, not necessarily workspace recovery.
- `agents/memory`: durable knowledge and authority over later behavior.
- `agents/models`: role-specific model/reasoning choices and inheritance.
- `agents/access`: usable service capabilities; `agents/access/headless` narrows
  this to setup-once authorization usable remotely without a local-browser flow.

### systems

- `systems/live-source`: applications consume editable tracked files.
- `systems/source-alignment`: installation/build/runtime use the same source and
  manifest; intentional local edits are not automatically version mismatch.
- `systems/configuration/authority`: who owns persistent settings and overwrites.
- `systems/configuration/links`: canonical files, installed links and collisions.
- `systems/updates`: package/runtime refresh with compatibility preserved.
  `systems/updates/overrides` concerns carried exceptions;
  `systems/updates/propagation` concerns published changes reaching actual hosts.
- `systems/services/ownership`: which launcher/process owns a service and data.
- `systems/services/lifetime`: survival beyond app/SSH exit and intended uptime.
- `systems/storage`: locate disk growth and selectively reclaim space.
- `systems/remote`: actual host identity/role; `systems/remote/runners` narrows to
  provisioning another host as a build/simulator runner.
- `systems/trust`: trust stores, signing/trust configuration and runtime exposure.

### preservation and engineering

- `preservation/sync`: active files available across devices.
- `preservation/backups`: recoverable copies and failure/destination policy;
  `preservation/backups/schedules` narrows to timing, units and missed runs.
- `engineering/native`: adopt native APIs while retaining unique behavior.
- `engineering/contracts`: adapters and guarantees at integration boundaries.
- `engineering/contributions`: fit receiving-project conventions and review;
  `engineering/contributions/forks` narrows to lineage and upstream alignment.

sync is not backup; editable source is not source alignment; library currency is
not complete API coverage. retain these distinctions when grouping evidence.

### interfaces

- `interfaces/output/boundaries`: separate tool-result identity.
- `interfaces/output/excerpts`: useful content selection within one result.
- `interfaces/motion/transitions`: geometry/backdrop/content timing.
- `interfaces/motion/stacks`: scroll-to-stack/sheet movement.
- `interfaces/interaction/targets`: intended clickable surfaces through states.
- `interfaces/interaction/focus`: keyboard-visible versus pointer focus.
- `interfaces/appearance/fonts`: intended typeface and typography consistency.
- `interfaces/appearance/colors`: coherent, legible palettes and secondary marks.
- `interfaces/performance`: reduce cost without discarding the desired appearance.
- `interfaces/diagrams`: chart support, sizing and renderer differences.
- `interfaces/assets`: derived share material faithful to page facts and motif.

### verification

- `verification/regressions`: repeat a demonstrated failure to prevent return.
- `verification/isolation`: real integration exercises cannot touch production.
- `verification/environment`: repair clock/config/subprocess assumptions in tests.
- `verification/parity`: capability reachability beyond SDK version currency.
- `verification/redundancy`: distinct behaviors versus inflated matrices/counts.
- `verification/visuals`: inspect actual rendered states, not only build results.
- `verification/benchmarks`: repeated measurements with aggregates/examples.
- `verification/readiness`: installed prerequisites versus consuming-client access.

these name evidence-producing work. a request for evidence is an interaction;
an assistant saying checks passed is a claim, not independent execution evidence.

### money

- `money/banking`: bank/card access, safety and experience;
  `money/banking/rewards` narrows to points, eligibility and bonuses.
- `money/flows`: ordered company-to-person-to-investment path;
  `money/flows/fx` narrows to conversion routes/spreads;
  `money/flows/distributions` narrows to transfer timing/tax treatment.
- `money/liquidity`: accessible balances/currencies before committing the rest.
- `money/scenarios`: adjustable outcomes and recognizable purchasing power.
- `money/borrowing`: financing eligibility and liquidation tradeoffs.
- `money/expenses`: company purchases and tax questions, not proven deductibility.

### personal, media and devices

- `personal/relationships`: expressed needs and shared responsibilities.
- `personal/follow-through`: intentions to doable actions, not a diagnosis.
- `personal/appointments`: preparation for the next appointment.
- `media/transcription`: faithful recording-to-text, pipeline and track handling.
- `media/clipping`: source media into an established useful note format.
- `media/curation`: usable collections from real reference material.
- `media/filing`: artifact destination, attribution and naming.
- `devices/sideloading`: phone app installation/provisioning.
- `devices/ports`: desktop runtimes/games rebuilt or run on phones.
- `devices/control`: small direct actions, not enduring preferences.

## collaboration

### scope

- `scope/drift`: a neighboring problem displaces the intended outcome.
- `scope/alternatives`: an unwanted either/or excludes compatible interests.
- `scope/boundaries`: explicit extent/permission limits.
- `scope/expansion`: deliberate broader coherent authorization.
- `scope/priority`: architectural intent versus an assistant's speed shortcut.

changed intent need not be an agent mistake. a justified question or option
selection need not be a correction. preserve the sequence before interpreting it.

### grounding

- `grounding/precedents`: actual established workflow/reference before guessing.
- `grounding/freshness`: current capabilities rather than remembered limits.
- `grounding/circumstances`: relevant known personal/local facts, not assumptions.
- `grounding/proof`: corroboration or a check actually addressing the claim.
- `grounding/tradeoffs`: explanation/comparison with room for genuine acceptance.

not every “why?” means undo; a request is not proof of delivery; private evidence
can be cited without reproducing unnecessary sensitive details.

### delivery

- `delivery/continuation`: finish authorized work, not only plans/status/slices.
- `delivery/review`: work reaches the surface the human actually reviews.
- `delivery/access`: accommodate the user's client/device, not only the host.
- `delivery/reconciliation`: identify concurrent/forgotten work before shipping.
- `delivery/convergence`: distinguish committed, merged, activated and running.
- `delivery/experience`: usable result and lived failure versus reported checks.

### presentation and adaptation

- `presentation/density`: concise with relevant detail and evidence retained.
- `presentation/disclosure`: content before bookkeeping; useful progressive detail.
- `presentation/examples`: concrete mechanisms/scale rather than abstract labels.
- `presentation/rationale`: lasting intent rather than duplicated mutable facts.
- `adaptation/reversal`: genuine updated choice, not necessarily prior error.
- `adaptation/uptake`: human acceptance/action, not proven long-term effectiveness.
- `simplification`: machinery challenged for lack of distinct demonstrated need;
  not a blanket preference for fewer tests or less evidence.

## source anchors and counterexamples

these are provenance for the vocabulary, not a required review selection. retrieve
native history in the stated workspace and pin the returned branch before using
an example in a proposal. don't infer historical outcomes from these summaries.

- native editing intent: workspace `/Users/bdsqqq/commonplace/01_files/nix`,
  session `01a0e9c0-42fa-70b7-abfe-7c4ae1fa4c3c`, leaf `9ae2bd66`, entries
  `f9fcf075`, `c6b6a6c6`. counterexample: same workspace, session
  `01a136ce-7b10-7637-b89f-ed94fdddbe1f`, leaf `7a782c58`, entry `a672b19e`
  explicitly chooses activation-owned backup policy.
- native schedule semantics and justified tradeoffs: workspace
  `/Users/bdsqqq/commonplace`, session `01a1364c-7f8c-74f1-bc35-d830074d4c96`,
  leaf `789052e6`, entries `d01d6df7`, `e6167462`.
  same backup continuation as above, not independent recurrence.
- source-backed, concise personal advice: workspace `/Users/bdsqqq/commonplace`,
  session `01a15032-eda6-72a1-8c1c-dc02f6116bae`, leaf `dd82119a`, entries
  `5ec85125`, `cac133bd`. no clinical facts are needed to observe the requested
  brevity and evidence.
- reuse the actual transcription pipeline: workspace `/Users/bdsqqq/commonplace`,
  session `01a15a26-e45b-7370-91e8-df3d9232dbec`, leaf `2488f6c4`, entries
  `e602332c`, `846a148d`. the assistant admits matching an older method without
  first inspecting the defined workflow; inspect surrounding native context.
- distinct tests versus counts: workspace `/Users/bdsqqq/www/lnr`, session
  `01a0c9ff-ccff-7106-aa80-086d00182476`, leaf `d5973432`, entries `5b6e9b35`,
  `e3e9561a`. the user challenges
  possible bloat; the assistant supplies redundancy allegations. do not turn
  this into a test-count cap or claim the allegations were independently checked.
