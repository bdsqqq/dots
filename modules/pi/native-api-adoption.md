# native-api adoption — 2026-09-30

implemented against installed pi 0.87.1:

- child RPC completion waits for `agent_settled`, not assistant stop counts.
  retry errors no longer terminate a recoverable run. eager report follow-ups,
  deadlines, parent cancellation and process-group cleanup remain.
- exact child-session lookup uses native header-only `findById`. duplicate IDs
  follow native first-header-match resolution, not the former activity sort.
- background requests use registry streaming for runtime authentication,
  endpoint selection and cancellation. existing injected completions retain
  their auth contract.
- dynamic environment guidance uses a named native prompt section. an earlier
  opaque full-prompt override retains append behavior so chained guidance is
  not lost.

## retained boundaries

native `RpcClient` is not a supervisor equivalent: the installed implementation
launches node directly and does not create a detached process group. retaining
raw stdio avoids replacing `PI_BIN`, child environments and group cancellation
with a larger adapter. SDK embedding also removes process isolation; neither
change is necessary to adopt native settlement.

the injected completion path serves existing naming/recap tests and remains
separate from production native streaming. arbitrary configured prompt bodies
are not split or reinterpreted as native headings.

## upstream 0.99.1 assessment

the [upstream changelog](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md)
lists 0.99.0 and 0.99.1 on september 29:

- sol 6.1 catalog support and default selection;
- ChatGPT login under the OpenAI provider, superseding legacy Codex routing;
- virtual models with request-level model/effort selection;
- native codemode and nested tool execution/accounting;
- theme, tool exposure, built-in extension provenance and RPC input changes.

recommend a separate upgrade, not a dependency bump hidden in this refactor.
acceptance must cover local SDK/provider/TUI patches, strict-schema fallback,
custom tool selection, child cancellation/settlement, authentication, prompt
layering and custom rendering. virtual routing and nested accounting merit
evaluation after that compatibility work; they do not replace separate child
conversations or durable messaging.

no upgrade, activation or live-provider comparison was performed.

## evidence

typechecking and 109 targeted tests passed; two gated delegate tests skipped.
tests exercise subprocess protocol fixtures, native tool selection, native
runtime auth with a faux provider, and native prompt-handler chaining.
these are not production provider recordings. an attempted isolated
old-behavior mutation check was blocked by temporary-file patch restrictions;
no claim that the new tests were demonstrated to fail against old code.
