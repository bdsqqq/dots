# rendering sampler

from `modules/pi`:

```sh
pnpm run test:rendering
```

requires the installed workspace dependencies and `tmux` on `PATH`. no new terminal framework, model credentials, desktop access, or network is needed. a private tmux server uses only a generated `history-limit 50000` configuration (set before pane creation so earlier root frames survive narrow reflow); it never attaches to or restarts an existing session.

## why a real session

codemode children produce native summary rows, not their custom tool renderers. the sampler therefore calls **every registered tool directly** (including dormant native grep/find/ls/powershell), separately from nested calls. registration inventory is an assertion, not rendering coverage. pi's CLI, extension registrations, agent loop, tool execution, shared tool shell, native markdown renderer, and terminal input path remain production code.

outer and child **model responses and usage are synthetic**. child processes are actual pi CLI/RPC processes: each runs the production read tool against a temporary file before its deterministic model completes. HTTP and `gh` API responses are fixtures; the production search/page/github tool implementations still execute. offline sockets are forbidden by the existing boundary preload. writes, edits, mailbox messages and session files stay in the private temporary workspace; public `flake.nix` ranges and `assets/susuwatari.jpg` are read from this checkout.

## evidence contract

before opening the PTY, `matrix.json` records consumers, inputs, expected content, pending states, keyboard actions, widths and synthetic boundaries. each run prints its retained artifact directory, including failures:

- `provenance.json`: revision, source/selected runtime hashes, viewport and limitations;
- `events.jsonl`: real tool lifecycle, nested ids, results and progress;
- `renders.jsonl`, `observed-tool-execution.js`: observation-only loader copy records actual call/result component lines during the real TUI render. output is unchanged; assertions match the result region back to the PTY grid, rather than accepting an echoed command/query/source marker. native write/edit previews are explicitly call-side previews, paired with real filesystem assertions, not claimed as result text;
- `raw.ansi`: pi's actual terminal writes;
- `INDEX-WIDTH-{collapsed,expanded,recollapsed}.txt`: tmux-rendered grids, at 20, 80 and 140 columns × 160 rows;
- `INDEX-80-pending.txt`, `INDEX-frame.txt`: pending states and isolated latest root frames;
- `report.json`: successful assertions and limitations; failures instead leave `failure.txt`;
- `negative-control/`: copied grids with missing/duplicate chrome checks and an additional fresh runtime whose **isolated copy** of the production tool component omits the footer. that run must fail the same grid assertion. working source is never patched.

ctrl+o is sent through the PTY, not by setting component state. checks require hidden reads and middle bash output to appear and disappear, distinguish actual content from loading placeholders, count root lifecycle/chrome independently of nested connectors, check widths, compare child usage/tree to executed results, and reject unexpected tool errors. codemode covers discovery, `ALL_TOOLS`, real directory reads with `Promise.allSettled`, partial failure, structured/long output, child summaries, concurrent agents/search, page retrieval and timing. markdown checks rendered span attributes, link/inline styling, quote indentation, table borders/content, typescript/diff fences, terminal mermaid geometry, ordered/nested/task lists, long identifier wrapping and rule position. isolated negatives remove results while keeping inputs, remove each markdown shape, and substitute a sentinel-only assistant frame; each must be rejected.

these are **terminal grids, not screenshots**. no desktop image-pixel claim is made. image coverage includes native decoding/text fallback in tmux plus isolated kitty and iTerm2 protocol dispatch through the production regular-mode renderer. `image-kitty.json` and `image-iterm2.json` retain body geometry and dispatched bytes; matching `.ansi` files retain raw output. `image-kitty-fullscreen.json`/`.ansi` additionally capture the actual fullscreen renderer cropping an image with its anchor zero to three rows above a four-row viewport, at widths 20/40 and output padding 1/3. these fullscreen checks use an in-memory terminal boundary, not a fullscreen PTY/startup test. fullscreen iTerm remains natively unsupported. the fixture terminal records output but does not display pixels. powershell is exercised only through its real “only available on Windows” error on this darwin host; successful windows execution is unverified. regular mode leaves mouse selection/scrollback to the terminal, so mouse/hover are not tested. the large row count retains tool frames for assertions; ordinary short viewport scrolling and fullscreen mouse behavior are not covered. the native mermaid renderer produces a terminal diagram (the sampled `A → B` graph), not browser pixels. evidence is local, not published. delete retained temporary directories when no longer needed.

## bounded context and raw recovery

ctrl+o means **more context**, not an unbounded dump. codemode captures native `text()` and returned-value boundaries before numbering, joining or execution truncation: a huge first result cannot hide the next result. optional version-1 `outputPreview` details retain at most eight evenly spaced results (first and last included), each with at most 224 UTF-16 code units across its head/tail. console, diagnostics and saved image paths have separate bounded clips; image bytes stay native. write failures are captured at the filesystem boundary: one spill-failure clip and a counted first image-save failure are rendered before results, independently of image visibility or script success. failed spills explicitly say full output is unavailable and `/tool-output` contains retained raw only. script diagnostics remain separate. the retained strings total at most 2912 code units (13 × 224), independent of emission count; the 1000-emission production test also checks serialized metadata below 16 kib. omitted character counts mean UTF-16 code units, not guessed visual rows.

collapsed output shows first/last previews; expansion shows all selected emissions in order, with exact result gaps. expanded output allocates at most 40 body visual rows (at most eight per section), plus bounded headings/hints. script/call windows remain 6/8 collapsed and 12/12 expanded. missing, unknown-version or malformed preview metadata uses the existing whole-output window (5/20 rows); rendered `==> text N/M <==` strings are never parsed. output remains opaque text, including minified JSON; no guessed parsing changes its representation. native call rows are single-line and prioritize exceptional statuses, with omitted failures counted. direct children put their answer first (8/26 visual rows, including the omission row), then diagnostics, expanded task context, activity and usage/continuation. the sampler requires useful expansion and re-collapse at every sampled width; original tool input/content/details/usage are compared before/after component rendering.

`/tool-output [exact-tool-call-id]` exports the selected **active-branch persisted call and result**, not the full transcript. without an id, the native picker selects a result. the sampler sends this through the real terminal command path after the agent settles: cancel writes nothing, selection exports, explicit-id recovery includes a sentinel absent from both views, and parsed JSON must equal the known persisted entries. `raw-*.txt`, `branch-{before,after}.json`, and private `pi-tool-output-*/persisted-result.json` retain this evidence. isolated negatives reject old unbounded native Text expansion and preview-only/missing-sentinel exports.

exports may contain secrets, image data and original arguments. they are user-invoked private temporary copies (directory 0700, file 0600), retained until removed by the user or OS; rendering never writes them. **do not publish sampler directories wholesale.** compact child results remain compact: an export cannot recover discarded child transcripts or execution-time truncation. an execution spill path is checked separately for file availability, never silently copied or advertised as recovered content. synthetic available/missing spill metadata exercises both notifications; `raw-available-spill-status.txt` and `raw-explicit-status.txt` distinguish them. actual codemode truncation/discovery remains covered separately.

## live replay is disabled

`--live` is rejected before creating a workspace, reading credentials, starting pi, or submitting requests—even with `PI_RENDER_LIVE_ACK=uncapped-cost`. the opt-in spelling is reserved, not an executable live feature.

provider request hooks do not count actual transport submissions: websocket reconnects and SSE fallback may submit again without another hook. the previous four-request claim is withdrawn. token payload limits and dollar-cost caveats do not repair that gap. live replay must remain disabled until an actual transport-boundary budget is demonstrated offline against retries/fallbacks; no live request was used to verify this repair. live network/model replay is not implemented or verified; unused live helpers and launch paths have been removed.

## focused maintenance checks

```sh
pnpm exec vitest run --config scripts/rendering-vitest.config.ts
pnpm exec tsc -p scripts/tsconfig.rendering.json --noEmit
pnpm exec tsc -p tsconfig.build.json --noEmit
pnpm run test
pnpm run build
```

no nix output consumes these new scripts; no host build, activation or running-session reload is needed. source-aware copying remains out of scope.
