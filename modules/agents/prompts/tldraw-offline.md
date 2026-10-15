---
name: tldraw-offline
description: Operate the user's tldraw offline canvas app, including open .tldraw or .tldr files. Use whenever a task involves inspecting, editing, arranging, connecting, linting, or scripting a tldraw Desktop canvas.
---
<!-- installed-by:tldraw-desktop-agent-skills -->

# tldraw canvas operator

Use this skill for tasks involving open tldraw Desktop files. The desktop app exposes a local HTTP server that can list documents, inspect canvas state, capture screenshots, execute JavaScript against a live editor, and expose live script files for durable behavior.

## Server

The default server is `http://localhost:7236`. If that port is not active, read the `port` from `/Users/bdsqqq/Library/Application Support/tldraw/server.json`.

A clean quit removes `server.json`; the next launch rewrites it. It also records `pid` and `startedAt`, so if the file is present but requests to its `port` fail, treat it as stale (the app quit uncleanly) — the app is not running.

Every request except `GET /` and `/readme` needs the per-launch `token` from that same `server.json`, sent as `-H "authorization: Bearer <token>"`.

**If the server's base URL and bearer token are already in your context** — the app injects them at subagent launch when its agent hook is installed — use those literal values directly, or just call the installed `tq` helper (below). The rest of this section is the fallback for when neither is in hand.

**Each Bash tool call runs in a fresh shell — exported env vars do NOT persist between calls.** A `TLDRAW_TOKEN` you `export` in one call is empty in the next, so the request sends `authorization: Bearer` with no token and 401s. "Export once and reuse" does not work here — re-establish the port and token on every call. Read them together at the top of each call (both stay fixed for the app's lifetime, so re-reading is cheap):

```bash
PORT=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port' '/Users/bdsqqq/Library/Application Support/tldraw/server.json'); TOKEN=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token' '/Users/bdsqqq/Library/Application Support/tldraw/server.json')
# use as:  http://localhost:$PORT/...   -H "authorization: Bearer $TOKEN"
```

### Helper: `tq`

A ready-made helper ships with this skill at `"$HOME/skills/tldraw-offline/tq.mjs"`. Invoke it as `node "$HOME/skills/tldraw-offline/tq.mjs" <METHOD> <path> [body]` — it re-reads the port and token from `server.json` itself on every call, so you never handle the token or the fresh-shell env problem. A body starting with `{` is sent as JSON; anything else as raw `text/plain`:

```bash
node "$HOME/skills/tldraw-offline/tq.mjs" POST /api/search '{"code":"return await api.getDocs()"}'
node "$HOME/skills/tldraw-offline/tq.mjs" POST /api/doc/DOC_ID/exec 'return editor.getCurrentPageShapes().length'
node "$HOME/skills/tldraw-offline/tq.mjs" GET  /api/doc/DOC_ID/script-status
```

Prefer it on Windows and in any non-POSIX shell: it uses no shell substitution or pipelines, so the same line runs unchanged in bash, zsh, Git Bash, and PowerShell, whereas the `PORT=$(...)` blocks below assume a POSIX shell.

If `tq` is missing (an older install), fall back to raw `curl` with the `PORT`/`TOKEN` reads shown above. The raw-`curl` examples below stay in explicit form so each request is visible; translate any to `node "$HOME/skills/tldraw-offline/tq.mjs" <METHOD> <path> [body]`.

```bash
curl -s http://localhost:7236/readme
```

## Core endpoints

- `POST /api/search`: run JavaScript with an `api` object. Use this to discover docs, read shapes and bindings, capture screenshots, and query the editor API reference.
- `POST /api/docs/create`: create a new named `.tldraw` file, open it in a new window, and save it to disk. Use this when the task needs a fresh document rather than an already-open one.
- `POST /api/doc/:id/exec`: run JavaScript with a live tldraw `editor` scoped to one document. Use this for canvas edits.
- `POST /api/doc/:id/script-workspace`: expose a locally owned document's live script paths for direct durable board-script and asset edits.
- `GET /api/doc/:id/script-status`: inspect a locally owned document's watcher state for `script/**` edits and find `errorLogPath`.
- `GET /api/doc/:id/scripts`: list the `/exec` snippets running in the document right now (id, start time, status, code preview) plus the board script's last run outcome. Ask before you write to a board you did not start.
- `DELETE /api/doc/:id/snippets/:snippetId`: fire a snippet's abort signal, stopping the listeners, timers and animation loops it registered against `signal`. The `snippetId` comes back on the `/exec` response and from `/scripts`. Works on a snippet that already returned — that is the one still holding listeners — and the response's `aborted` reports only whether execution was interrupted. A snippet that ignores its signal runs to completion: this is a stop request, not a kill. It is also not an undo — edits the snippet already made stay on the canvas (a snippet that fails on its own IS rolled back), and its `/exec` call answers `success: false` with an error beginning `Snippet stopped:`.
- `POST /api/doc/:id/reload`: reload a locally owned document's window when it crashed, hung, or shows "Something went wrong". Answers once the editor is back; the doc id is unchanged and unsaved edits survive.

The code-taking POST endpoints accept raw JavaScript as the request body (`content-type: text/plain`) or a JSON body `{"code": "..."}`, and wrap the code in an async function so top-level `await` works. Prefer raw bodies for shell use.

## Use this first

Most tasks do not require searching `api.members`. Start with these calls and search the full Editor API only if a snippet fails or you truly need an unknown method. The object is `api`, not `spec`. Each block below is shown as raw `curl` so the request is visible; `node "$HOME/skills/tldraw-offline/tq.mjs" <METHOD> <path> [body]` is the shorter equivalent that handles the port and token for you.

```bash
# Fresh shell per call: re-read port + token first (or use the values already in your context).
PORT=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port' '/Users/bdsqqq/Library/Application Support/tldraw/server.json'); TOKEN=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token' '/Users/bdsqqq/Library/Application Support/tldraw/server.json')

# Pick the target doc by focused window or filename.
curl -s -X POST http://localhost:$PORT/api/search \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"code":"return await api.getDocs({ name: \"NAME\" })"}'

# Read the current page's shapes with ids, bounds, text, and metadata.
curl -s -X POST http://localhost:$PORT/api/search \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"code":"const doc = await api.getFocusedDoc(); const page = doc ? await api.getShapes(doc.id) : null; return { doc, shapes: page?.shapes.map(s => ({ id: s.id, type: s.type, x: s.x, y: s.y, props: s.props, meta: s.meta })) ?? [] }"}'

# Read bindings only for connection-dependent behavior.
curl -s -X POST http://localhost:$PORT/api/search \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"code":"const doc = await api.getFocusedDoc(); return doc ? await api.getBindings(doc.id) : []"}'
```

Every listed doc has `ownership: 'local' | 'remote' | 'server'`. A remote or server doc's `id` (opaque connection id for remote; the server's board id for server) works with `/exec`, `api.getShapes()`, `api.getBindings()`, and screenshots, but its `documentId`, `filePath`, and `unsavedChanges` are `null`: only the host (or server) owns those facts, and `host` carries the `host:port` it came from. Remote edits sync into the host working copy; server edits sync into the server's durable storage on their own. Do not call `helpers.saveDoc()`, open `/script-workspace`, or claim an archive was saved for a remote or server doc. A server doc also carries `serverUrl`: its script is edited on the server through that API — read the `script-a-board-on-an-offline-server` recipe.

A local doc also reports `shared`. True means the board is shared right now and other people are editing it as you work: read before you write, and never clear a page you did not create.

## Scripts on a shared board

Writing or editing a board script for a board that is (or may become) shared changes what the script may do, because **every participant's editor runs the whole bundle** — `config.js` before it mounts, `main.js` after — and nothing elects a writer:

- Registration and rendering (`config.js` utils, view-only reactions) must run on every client, identically. A client that doesn't register a script-defined shape type renders an inert placeholder instead.
- Writes happen once per client unless guarded. Gate them on `ctx.app.board.isHost` — true in the editor that owns the file, false in one that joined — and keep continuous work (`tick` handlers, timers, simulations) behind the same guard. A never-shared board has one editor and it is the host, so the guard is correct offline too.
- Create with stable ids via `helpers.createShapeIfMissing` / `createShapesIfMissing`; never clear-and-redraw a page other people are on.
- Keep per-client state (hover, selection, "which card is flipped for me") in module scope, not in shape props — writing it to the document broadcasts one person's UI to everyone.

Read the `scripts-on-a-shared-board` recipe from `api.recipes` before writing one.

## Creating documents

When the task needs a fresh document (not one of the open canvases), `POST /api/docs/create` with a JSON body `{"name": "..."}` creates `<name>.tldraw`, opens it in a new window, and saves it to disk immediately. The name takes a `.tldraw` extension or none — never legacy `.tldr`, which the app opens but does not create. Optional `"directory"` is an absolute path to an existing folder; the default is the user's Documents folder. It never overwrites — an existing file with that name is a `409`. The response returns the new doc's `id`, `documentId`, `filePath`, `name`, and `windowId` — use that `id` directly with `/api/doc/:id/exec` and the `api.*` reads, no `api.getDocs()` re-discovery needed. Do not create the file yourself with filesystem tools.

```bash
curl -s -X POST http://localhost:$PORT/api/docs/create \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"name":"Project Plan"}'
```

## Reference recipes

`api.recipes` (via `/api/search`) is an object keyed by recipe `id`; read one in full with `api.recipes['<id>']`. Query it when a task matches one of the worked recipes:

- `stack-existing-boxes` — Stack existing boxes
- `group-shapes-with-a-box` — Group shapes with a box
- `connect-shapes-with-bound-arrows` — Connect shapes with bound arrows
- `draw-a-diagram-from-mermaid` — Draw a diagram from mermaid
- `add-durable-behavior-with-a-board-script` — Add durable behavior with a board script
- `script-a-board-on-an-offline-server` — Script a board on an offline server
- `editable-furniture-with-anchored-internals` — Editable furniture with anchored internals
- `scripts-on-a-shared-board` — Scripts on a shared board
- `comment-threads-read-reply-resolve` — Comment threads: read, reply, resolve
- `clickable-card-or-button-ui` — Clickable card or button UI
- `connection-dependent-behavior` — Connection-dependent behavior
- `animation-simulation-loop` — Animation / simulation loop
- `custom-shape-config-js` — Custom shape (config.js)
- `custom-binding-config-js` — Custom binding (config.js)
- `custom-overlay-config-js` — Custom overlay (config.js)

Fetch `/readme` when an endpoint fails or you need API details not covered here.

## Durable UI Behavior

For durable UI behavior on a locally owned document, open `/script-workspace`, write `script/main.js`, check `script-status`, then verify behavior once. `script-status` returns a derived `state` field — treat `state: "applied"` as success; `"pending"` means the watcher hasn't applied the current file yet — poll again and it resolves (a file saved while the app was restarting is applied automatically the next time you open `/script-workspace` or read `script-status`, no manual re-save needed); `"error"` means the apply failed (read `lastApplyError` / `errorLogPath`). Branch on `state` rather than comparing the raw digests yourself. The `/script-workspace` response reports `isDefaultScript` (true while `script/main.js` is still the untouched starter template, pre-created when absent) — when `isDefaultScript` is false there is a preexisting script to extend, not clobber. Read `mainJsPath` to see the current contents before editing (and read it once first if your file tools refuse to write a file they have not read). Remote boards have no local script workspace or watcher status; their host owns the script files. An offline-server board has none either — its script is written on the server itself (the `script-a-board-on-an-offline-server` recipe), and the windows on it hot-reload. Do not spend the run searching for pointer/click APIs — read the `clickable-card-or-button-ui` recipe from `api.recipes` first. Never `window.addEventListener` for keys or clicks: clicks go through that recipe, keyboard shortcuts through a tool registered in `config.js`. A shape that does something when clicked is a control, not content: create it with `isLocked: true`, or lock a user-drawn one with `editor.updateShapes`, so a click runs the action instead of selecting the shape, and a second click does not open its label. Only controls get locked — the shapes they act on and furniture the user should move stay unlocked. `editor.updateShapes` silently skips a locked shape, so a script's own writes to a control (a pressed look) go through `editor.run(fn, { ignoreShapeLock: true })`. Tell the user the controls are locked and that Edit → Unlock All frees them.

## Shape format

`api.getShapes()`, `/exec`, and board scripts all use raw tldraw SDK records. Create shapes with normal tldraw partials. Prefer importing primitives from `'tldraw'` when the host import map is active — in an `/exec` snippet use `await import('tldraw')` (a snippet can't use a static `import`); a board script can use a top-level `import { createShapeId } from 'tldraw'`. The `helpers` bag carries only editor-bound conveniences (not SDK primitives) — import primitives from `'tldraw'` directly. Read `api.imports` (from `/api/search`) for the full list of importable symbols:

```js
const { createShapeId, toRichText } = await import('tldraw')
editor.createShape({
	id: createShapeId('box1'),
	type: 'geo',
	x: 100,
	y: 100,
	props: { geo: 'rectangle', w: 300, h: 200, richText: toRichText('Label') },
})
await helpers.saveDoc()
```

The `helpers.saveDoc()` call above is only for `ownership: 'local'`. Omit it for a remote doc (its edits sync to the host working copy and only the host saves the archive) and for a server doc (its edits persist to the server on their own).

Saving a local doc is your job, not the user's — except a doc that has never been saved. Whenever a local doc reports `unsavedChanges: true` and has a `filePath` — including after script-workspace edits, which mark the doc unsaved — save it yourself with a one-line exec snippet: `{"code": "await helpers.saveDoc()"}`. Never ask the user to save or press Cmd+S. A doc with `filePath: null` has never been saved; skip it and mention the doc is unsaved.

Use `api.getShapes(doc.id)` to inspect existing raw shape records before mutating them; read a label's visible text with `helpers.richTextToPlainText(shape.props.richText)`, not by parsing the rich-text JSON. Draw a labeled container around existing shapes with `helpers.boxShapes`, not a hand-placed rectangle — the `group-shapes-with-a-box` recipe is the worked example.

Arrange existing shapes with `editor.alignShapes(ids, 'top')`, `editor.stackShapes(ids, 'horizontal', gap)` and `editor.distributeShapes(ids, 'horizontal')`, not hand-computed x/y loops. For edges, anchoring and hit-testing use the shape's geometry, not its bounding box: `editor.getShapeGeometry(shape).nearestPoint(editor.getPointInShapeSpace(shape, pagePoint), Geometry2dFilters.EXCLUDE_LABELS)` gives the outline point (`Geometry2dFilters` is imported from `'tldraw'`; without the filter a labelled shape can answer with its label's edge) (map it back with `editor.getShapePageTransform(shape).applyToPoint(p)`), where `getShapePageBounds` puts it on the corner of an ellipse or rotated shape.

A card and the words on it are one shape: the words go in the geo's `richText` label, as above; a long label wants a bigger card (`verticalAlign: 'start'`), not a separate `text` shape. `text` shapes are for words that stand on their own, like a heading over a group of cards.

A text box sits fully inside a panel or frame or fully outside it, never across its border, and nothing inside a frame extends past the frame's edge; `helpers.getLints()` reports both as `text-crosses-container` and `shape-outside-frame`. A shape parented to a frame or group takes `x`/`y` relative to that parent, not the page: a card for a column frame at page x 360 gets local x 20, not 380. `editor.reparentShapes(ids, frameId)` keeps page positions when moving existing shapes in.

### Freehand draw shapes

A `draw` shape's `props.segments` hold delta-encoded base64 `path` strings, not point arrays — a segment like `{ type: 'free', points: [...] }` fails validation and crashes `createShape`. Never build `path` strings by hand: compute your points as `{ x, y, z }` objects (`z` is pressure; use `0.5`) and convert them with `compressLegacySegments` from `'tldraw'`. Coordinates are relative to the shape's own `x`/`y`:

```js
const { createShapeId, compressLegacySegments } = await import('tldraw')
const points = Array.from({ length: 48 }, (_, i) => {
	const t = (i / 47) * Math.PI * 2
	const r = 90 + 8 * Math.sin(5 * t) // wobble makes it read as hand-drawn
	return { x: r * Math.cos(t), y: r * Math.sin(t), z: 0.5 }
})
editor.createShape({
	id: createShapeId('loop1'),
	type: 'draw',
	x: 300,
	y: 300,
	props: {
		segments: compressLegacySegments([{ type: 'free', points }]),
		isComplete: true,
		isClosed: true, // closed paths can take fill
		color: 'blue',
		fill: 'semi',
	},
})
```

For a closed loop, end the points where they started. Multiple strokes are multiple `draw` shapes (or multiple segments). To read a draw shape's geometry back, decode is not needed — use `editor.getShapePageBounds(id)`.

## Screenshots

`api.getScreenshot(docId, opts?)` captures a JPEG to a temp file and returns `{ filePath, width, height, pageName, viewport, bounds, captureMode }` — a path, not image data, so open the file yourself to look at it. `opts.size` is `'small' | 'medium' | 'large' | 'full'` (default `'small'`). `opts.mode` is `'canvas'` (default — just the shapes, framed to their bounds) or `'window'` (the whole app window: canvas plus UI chrome); use `'window'` to see UI a script's `components` override draws outside the canvas. `opts.bounds` (`{ x, y, w, h }` in page coordinates) applies to `'canvas'` mode only. Prefer reading records with `api.getShapes()`; screenshot only when visual placement is uncertain or the user asks for visual proof.

## Diagram connections

- Create every meaningful connection with `helpers.createArrowBetweenShapes(fromId, toId, options)` so both endpoints have real bindings.
- Never create a raw arrow shape for a meaningful connection. Raw unbound arrows are only appropriate for explicitly decorative marks.
- Run `helpers.getLints()` before reporting a diagram complete and address every actionable result. The `connect-shapes-with-bound-arrows` recipe in `api.recipes` is the worked example; fetch `/readme` for the `meta.lintIgnore` opt-out for intentional decorative arrows.
- An `/exec` response may carry `lints: { new, resolved }`: the lints that snippet introduced and cleared. Fix every `new` lint before reporting done.
- For a whole diagram from structure — a flowchart, sequence diagram, state machine, or mindmap — generate it with `helpers.mermaid(source)` rather than placing nodes and arrows by hand; it creates real bound shapes. The `draw-a-diagram-from-mermaid` recipe is the worked example. Two or more diagrams to compare are still mermaid: one source with a `subgraph` per diagram (a `flowchart LR` puts them beside each other), or one call per diagram with `options.blueprintRender.position` set so they do not overlap. "Side by side", headings, and colours are not reasons to place nodes by hand.

## Comments

Comment threads are how people and agents talk about the canvas in context — each thread is anchored to a shape, a point, a region, or the page, so the anchor tells you what the words are about. `api.getComments(doc.id)` (via `/api/search`) returns every live thread with its anchor, plaintext comments, and resolved state; `supported: false` means this board has no comment lane — report that rather than working around it. When a task starts from a comment ("do what the comments say"), read the threads first and use each anchor to find the shapes under discussion. Reply in the thread you acted on and resolve it once its ask is done. A thread that asks you not to act, or that is addressed to someone else ("leave this one for Kevin"), is not yours: do not reply in it, do not resolve it, and do not touch its anchor — mention it in your summary instead; post a new thread anchored to what you changed when a note in context serves better than a chat summary. All comment writes go through `/exec` with the `@tldraw/commenting` verbs (`putCommentRecords`, `resolveThread`, …) — never a raw `store.put`, which puts comment records on the user's undo stack. A supported board that holds no threads yet has comments turned off: agent writes are reverted until the board owner enables commenting in the app, so ask the user first — except on an offline-server board (`ownership: 'server'`), which has no owner and no gate: a supported server board with no threads is simply empty, so write. Read the `comment-threads-read-reply-resolve` recipe from `api.recipes` before writing one.

## Workflow

1. Restate the intended outcome in concrete canvas terms. If the request does not say which shapes it means and nothing on the board says either ("make the important one stand out" over six identical cards), ask which and stop there: the turn ends with the question. An unanswered question is not permission to pick a default — write nothing until the answer comes.
2. Choose durability:
   - Static drawing edits such as moving, arranging, labeling, or styling shapes use `/exec`.
   - Durable behavior on a locally owned document such as clickable UI, animations, reactive layouts, or "run on open" logic uses `/script-workspace` and direct filesystem edits under `script/**`. Read the worked recipes from `api.recipes` (via `/api/search`) before building durable behavior. Remote boards have no local script workspace; an offline-server board's script is written on the server (the `script-a-board-on-an-offline-server` recipe).
3. Verify once with records from `api.getShapes()`, `api.getBindings()`, `api.getScriptStatus()`, or a screenshot when visual placement is uncertain. After a resize or move, compare `helpers.getLints()` from before and after your edit: fix only lints your edit introduced, on the shape you edited, never by moving a neighbour you were not asked to touch. Save only a locally owned document that has a `filePath` with `helpers.saveDoc()`; remote edits sync to the host working copy.
4. Stop after one successful verification unless the user explicitly asks for debugging.

Never edit `.tldraw` archive files directly while they are open, and never edit `db.sqlite`, `db.sqlite-wal`, `db.sqlite-shm`, `metadata.json`, `.lock`, or `.script-workspace/**`.

## Recovering from a closed or unresponsive target document

If an `/exec` or `/api/search` call on a locally owned `docId` fails because the renderer crashed, stopped responding, or timed out, or a screenshot shows "Something went wrong", the window is still open: `POST /api/doc/:id/reload` once, then retry the same `docId`. If it hung on your own edit, find the cause first (a loop in your snippet, or a board script reacting to it), or the retry hangs the window again. Unsaved edits come back with it. Only if the reload itself fails, treat the window as gone.

If a request comes back `"Window closed before responding"` or `"Document not found"`, that window is gone. Do not retry the same `docId`, and do not assume whatever `api.getDocs()` returns next is the same document — with more than one window open, the next call can silently resolve to a completely different, unrelated file.

- Call `api.getDocs()` fresh and match the result against the doc `name` (and `documentId` if you captured it) you were actually working on.
- **Name matches** → safe to resume against the new `id` for that doc.
- **No match, or `getDocs()` now returns only a document you never opened** → STOP. "The only open document" is not "the right document." Report that your target window closed and ask how to proceed instead of writing anywhere. If the task calls for a fresh document anyway, use `POST /api/docs/create` (above) rather than repurposing whatever `getDocs()` handed you.

Before any bulk or destructive edit (deleting all shapes on a page, clearing a doc to rebuild it), sanity-check what you are about to touch: read `api.getShapes(doc.id)` first and compare the shape count and content against what you expect on your own document. A nonzero shape count you did not create, or content unrelated to your task, means you are very likely on someone else's document — stop and report instead of deleting.

## Durable script pattern: editable furniture, anchored internals

Use this when a board script draws a board that users should rearrange or restyle while script-owned animation/game pieces still follow it.

- Create user-facing furniture with stable ids and `helpers.createShapeIfMissing` / `helpers.createShapesIfMissing`; never delete and redraw it on rerun. A shape that runs an action on click is a control, not furniture: create it with `isLocked: true`.
- Pick one visible anchor per interactive system, such as a track or table felt.
- Use `helpers.onShapeTranslate(anchorId, ({ dx, dy }) => ... , { signal })` to respond only to that anchor.
- Move script-owned internals with `helpers.translateShapes(..., dx, dy)` — the handler's dx/dy and the delta it consumes are both page-space, so pass them straight through even when shapes sit in frames or groups. It runs without recording undo history; wrap other script-owned writes in `editor.run(fn, { history: 'ignore' })`.
- Render per-frame or purely visual writes through `helpers.renderEphemeral(fn)`: they paint without dirtying the document, landing in a save, syncing to LAN participants, or entering undo. `history: 'ignore'` alone still persists every frame, so an animation written that way can never be saved cleanly.
- A shape id is bound to its type for the life of the editor: deleting a shape and creating a different type under the same id (in one batch or one `renderEphemeral` frame) leaves an "Error" badge in its place. Give a slot that changes type a new id. `helpers.getLints()` reports a shape showing that badge as `shape-render-error`, for shapes on the current page.
- Avoid broad `store.listen` / `afterChange` layout handlers that react to every shape; they can treat the script's own writes as new user edits and recurse.

## Editor customization: custom shapes, tools, and overlays (`config.js`)

Custom shape types, tools, overlays, or UI components need a `script/config.js` next to `main.js` (create it through `/script-workspace`, same as `main.js`) — a `main.js`-only script cannot register them. Its default export runs BEFORE the editor mounts, receives `{ config }` (the app's default `TldrawConfig`), and returns it after mutating or spreading it. The passed `config` carries `shapeUtils`, `bindingUtils`, `assetUtils`, `overlayUtils`, `tools` (arrays of constructors), `components` (a `TLComponents` map), and `options`; optional `getShapeVisibility(shape, editor)`, `assetUrls`, and `initialState`. Push your constructors onto the arrays — a util/tool whose static `type`/`id` matches a stock one replaces it. Custom shapes subclass `ShapeUtil` and custom overlays subclass `OverlayUtil` (both from `'tldraw'`); define them in a sibling file and `import` them, since `config.js` and `main.js` are separate module graphs.

Read the worked `custom-shape-config-js`, `custom-binding-config-js`, and `custom-overlay-config-js` recipes from `api.recipes` for the full `ShapeUtil` / `BindingUtil` / `OverlayUtil` skeletons before writing one. (Their lifecycle hooks — `onAfterChangeToShape`, `getGeometry`, `isActive`, … — are also indexed in `api.members`, tagged with an `owner`, so a name search finds them instead of only the SDK types.) Saving `config.js` (or a file it imports) rebuilds the store and editor — document, camera, and selection are preserved but undo history resets — whereas saving `main.js` never remounts. Keep run-on-mount logic in `main.js`; `config.js` only builds the config. Types live in `.script-workspace/script-context.d.ts` (`ConfigScriptContext`, `TldrawConfig`).

## Fast path for static edits

Shown as raw `curl`; `node "$HOME/skills/tldraw-offline/tq.mjs" <METHOD> <path> [body]` is the shorter equivalent that handles the port and token for you.

```bash
# Fresh shell per call: re-read port + token (or use the values already in your context).
PORT=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port' '/Users/bdsqqq/Library/Application Support/tldraw/server.json'); TOKEN=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token' '/Users/bdsqqq/Library/Application Support/tldraw/server.json')

# Discover docs.
curl -s -X POST http://localhost:$PORT/api/search \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"code":"return await api.getDocs()"}'

# Read shapes for a doc.
curl -s -X POST http://localhost:$PORT/api/search \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"code":"const [doc] = await api.getDocs(); return await api.getShapes(doc.id)"}'

# Mutate a LOCAL doc (one with a filePath) and save with /exec, then verify once with api.getShapes().
# For a remote doc, omit helpers.saveDoc(); its host owns archive saving.
curl -s -X POST http://localhost:$PORT/api/doc/DOC_ID/exec \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"code":"const { createShapeId, toRichText } = await import(\"tldraw\"); const id = createShapeId(\"r1\"); editor.createShape({ id, type: \"geo\", x: 100, y: 100, props: { geo: \"rectangle\", w: 200, h: 100, richText: toRichText(\"Hello\") } }); await helpers.saveDoc(); return { created: [id] }"}'
```

## Reporting

Keep summaries tight. Include the doc id/name, changed shape ids or script path, and the one verification result. If something fails, quote the server error, digest mismatch, or the relevant `.script-workspace/error.log` line.

## Filing a bug about the app

When the app itself misbehaves — a crash, a broken menu or shortcut, an endpoint that breaks its documented contract — the tracker is https://github.com/tldraw/tldraw-offline/issues. Search the open issues for a duplicate and comment there instead of opening a twin, and file only with the user's go-ahead.

Write the report plain-language and symptom-first. The title is what the user saw ("Cmd-M does not minimize on macOS"), never your diagnosis. Open the body with the repro steps, what happened versus what you expected, the app version (Help > About; on macOS, the tldraw menu), and the OS. Technical analysis — stack traces, suspected causes, server responses — goes below the fold, after the plain-language report.
