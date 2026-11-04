---
name: designing-invocable-operations
description: "Use when sharing operations across CLI, UI, API, SDK, jobs, or agent tools; extracting callable behavior from an interface; or generating interfaces from contracts/procedures. Not for component props/render slots, fetching composition alone, or a single route without reuse/generation needs."
---

# designing invocable operations

implement a capability once. interfaces adapt inputs, invoke it, and present its
outcome; they do not own a second implementation.

## start with a real operation and its callers

1. inspect the behavior, callers, existing schema/procedure tools, and compatibility
   promises. name one operation and the interfaces actually requested.
2. write the direct call and one interface call first. define input, output,
   expected failures, dependencies, and observable completion. distinguish
   accepted/queued from persisted/applied when that matters.
3. implement the smallest vertical slice, then exercise both paths. do not build
   hypothetical transports or a generic operation framework to demonstrate reuse.

for one local capability, exported functions and explicit dependencies may be
sufficient. use an existing procedure/router library when it already supplies the
needed validation, local invocation, or interface projection. contract-first is
an ownership decision, not a requirement for oRPC, classes, or separate files.

## declare the operation, not just the entity

a `Light` schema describes a value. `setBrightness` additionally needs an input,
a result, failure semantics, and an execution boundary. don't generate CRUD from
an entity just because its fields exist.

- derive types from authoritative schemas where runtime validation is needed;
  don't maintain an independent interface with the same fields.
- validate untrusted inputs at the callable boundary; every exposed path must
  reach that validation. local static types alone do not validate HTTP or argv.
  use the existing stack's output validation where promised.
- keep expected failures distinguishable: conflict, denied, invalid input,
  unavailable. a resolved failure is not success. preserve unexpected exceptions
  rather than translating them into empty data or successful completion.
- pass dependencies explicitly: storage, device access, clock, identity, or
  cancellation as needed. avoid ambient route state, argv, SDK context objects,
  and process globals in the operation's public contract.
- specify identity, branch/revision, lifecycle, and cancellation only where they
  affect behavior. supplied snapshots/resources must not trigger a hidden reread.

if generation is required, give the adapter inspectable procedure definitions or
existing router metadata—not a second handwritten operation catalog. data schemas
alone do not say whether a field is positional, a flag, stdin, or private context.
keep CLI presentation metadata separate from domain-required input; don't expose
internal discriminators or credentials as flags by accident.

## colocate by behavior; separate only real runtime boundaries

keep an operation's schemas, inferred types, use cases, errors, bindings, and tests
in its behavioral module. a fleet may contain node-catalog and desired-state
verticals. adding `node.exists` should not require a tour through global schema,
contract, operation, and router directories.

split files when ownership, size, or runtime dependencies justify it. a
browser-safe public contract and a Node-only binding can belong to the same
vertical without sharing an import graph. compose verticals through a thin public
entrypoint; do not turn the entrypoint into another implementation layer.

## expose the same implementation

```text
behavioral module: contract + handler + declared dependencies
  ├─ direct/local caller
  ├─ CLI adapter → arguments/stdin in, output/exit status out
  ├─ HTTP adapter → request/auth context in, response/status out
  │    └─ browser client → presentation and interaction
  └─ SDK/agent-tool adapter → tool input in, structured result out
```

adapters may parse transport syntax, establish authenticated context, and map
results to interface conventions. authorization must protect every supported
entry path; don't let a direct caller bypass checks owned only by HTTP middleware.
a browser calls a server capability through a client—it does not import database,
private-key, or device code. transport and authentication are separate choices
from the operation's domain contract.

reuse does not require every adapter to run in one process. a local client and a
remote client may offer the same call shape, while preserving their different
execution, failure, and trust boundaries. don't promise drop-in parity without
checking those differences.

## example: publishing is the capability, not the route

these TypeScript excerpts assume the existing schema, ports, and interface
framework. keep `PublishInput`, its inferred type, and `PublishDeps` with this
behavior; use the project's schema library, not a new one for this pattern.

**bad: two paths to the same mutation, with different guarantees.**

```ts
// CLI uses revision-aware publishing; HTTP bypasses it.
cli.action(args => notes.publishIfRevision(args));
app.post('/publish', async request => {
  await notes.write(await request.json());
  return Response.json({ status: 'published' });
});
```

**better: one callable boundary, two outcome mappings.**

```ts
// note/publish.ts — schemas, types, and dependency ports live here too
export async function publish(deps: PublishDeps, raw: unknown) {
  const input = PublishInput.parse(raw);
  await deps.requireWrite(input.noteId);
  // Storage checks the revision and writes atomically; no read-then-write race.
  return deps.notes.publishIfRevision(input);
}
```

CLI adapter: exit nonzero for a resolved conflict.

```ts
const result = await publish(cliDeps, args);
print(result);
process.exitCode = result.status === 'published' ? 0 : 1;
```

HTTP adapter: the same conflict becomes HTTP 409.

```ts
const result = await publish(requestDeps, await request.json());
return Response.json(result, {
  status: result.status === 'published' ? 200 : 409,
});
```

`publishIfRevision` returns `published` or `conflict`; existing adapter error
handling still maps validation, denial, and unexpected exceptions. the browser
calls HTTP and dismisses only on `published`; it never imports `cliDeps` or storage.
no operation registry is needed unless interface generation is actually requested.

## prove the slice, not the registration

use the repository's native test harness and real temporary resources. mock only
external boundaries, not the operation or adapter being checked.

- call the handler directly and through the requested interface. assert the same
  domain outcome and side effects, not just matching JSON or a registration spy.
- exercise invalid input, a meaningful failure, and success. ensure failure does
  not announce success, exit zero, dismiss UI, or report applied work prematurely.
- test ownership promises: supplied data after its backing file is removed,
  workspace/revision isolation, or concurrent writes where applicable.
- for generated interfaces, inspect actual help/schema and execute a command.
  add a third small operation: projection should not need a new parallel catalog.
- for browser-safe exports, use the existing bundler/boundary check to catch
  server-only imports. typechecking alone does not establish browser safety.
- challenge a new verifier in an isolated fixture: bypass validation, map conflict
  to success, or duplicate adapter behavior. the relevant check must fail.

[behavioral cases and origins](references/cases-and-origins.md) provide examples,
not a required framework or a second copy of repository architecture.

stop when the requested operations and adapters share checked behavior, or name
the concrete blocker. report direct behavior, adapter/runtime checks, and untouched
interfaces separately. component customization belongs to
[designing-progressive-apis](../designing-progressive-apis/SKILL.md); fetching,
drafts, and shell ownership belong to
[composing-data-driven-ui](../composing-data-driven-ui/SKILL.md).
