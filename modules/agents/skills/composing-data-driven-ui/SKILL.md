---
name: composing-data-driven-ui
description: "Makes data-backed UI work outside its original page. Use when callers need to supply data or fetch by ID, or reuse a feature in another shell without breaking queries, mutations, or drafts. Does not cover general API customization."
metadata:
  archetype: pattern-matching
---

# composing data-driven UI

let callers bring data—or just an ID—and choose where the feature goes.

this skill covers fetching, state, effects, and what belongs to the page or overlay around a feature. the types below make those choices explicit. designing overloads and customization APIs is a separate job.

## one feature, two ways to supply data

```tsx
// “show this team's members. handle the fetching for me.”
<Members teamId={team.id} />

// “show these members. i own this data.”
<Members members={invitedMembers} />
```

the first caller wants to embed a feature, not learn its query cache. the second already has the data. support both with the same presentation. supplied query data, filtered subsets, drafts, and fixtures must not trigger another fetch.

**data is part of composition.** it belongs in the contract, not hidden in the surrounding route. these TSX examples illustrate the pattern; use the codebase's primitives.

## let the caller choose the shell

either way of supplying data should work in either place:

```tsx
<PageSection><Members teamId={team.id} /></PageSection>
<PageSection><Members members={invitedMembers} /></PageSection>

<Tooltip content={<Members teamId={team.id} />}>
  <span tabIndex={0}>Members</span>
</Tooltip>
<Tooltip content={<Members members={invitedMembers} />}>
  <span tabIndex={0}>Invited members</span>
</Tooltip>
```

the page and tooltip wrap the same feature. neither needs its own members implementation. keep tooltip content read-only; editing needs an interactive shell.

```tsx
<Drawer open={open} onOpenChange={setOpen}>
  <MemberEditor mode="edit" member={member}
    onSuccess={() => setOpen(false)} onCancel={() => setOpen(false)} />
</Drawer>

<PageSection title="Edit member">
  <MemberEditor mode="edit" member={member} onSuccess={showSavedNotice} />
</PageSection>
```

same editor, different reactions to saving. the drawer closes; the page shows a notice. the editor must not secretly close or navigate.

**saving is a capability; the UI is one caller.** keep it callable outside a click handler, with typed inputs, results, and declared dependencies. reuse the existing I/O adapters so presentation tests don't have to mock network calls everywhere.

a resolved `{ status: 'conflict', current: member }` is still a failed save. show feedback and allow retry; don't call `onSuccess`. HTTP and CLI callers can handle the same result differently. don't turn unexpected exceptions into success or empty data.

reuse does not bypass runtime or authorization boundaries. a browser can call a server capability through a client adapter; it must not import the database code. designing that capability layer is outside this skill.

## pass the identity in

```tsx
// hidden dependency: embedding requires the page's state tree
const { selectedTeam } = useTeamPageContext();

// at the route boundary
<Members teamId={routeParams.teamId} />;
// elsewhere, independent of the active route
<Members teamId={project.ownerTeamId} />;
```

read the imports and hooks. moving a file out of a route folder does not remove its route dependencies.

app-wide theme, auth, and query services can use context if the requirement is documented. pass feature data explicitly. a feature root can accept or create a store and provide it to its children. keep instances separate and dispose only resources the feature owns. check overlays created by a manager: they may sit outside the caller's provider tree.

## supplied data means no second fetch

```tsx
type MembersProps =
  | { teamId: string; members?: never }
  | { members: readonly Member[]; teamId?: never };

type MembersState =
  | { status: 'loading' }
  | { status: 'error'; error: Error }
  | { status: 'ready'; members: readonly Member[] };

export function Members(props: MembersProps) {
  return props.members !== undefined
    ? <MembersView state={{ status: 'ready', members: props.members }} />
    : <FetchedMembers teamId={props.teamId} />;
}

function FetchedMembers({ teamId }: { teamId: string }) {
  const query = useQuery(membersQuery({ teamId }));
  if (query.isPending) return <MembersView state={{ status: 'loading' }} />;
  if (query.isError) return <MembersView state={{ status: 'error', error: query.error }} />;
  return <MembersView state={{ status: 'ready', members: query.data }} />;
}
```

one input decides where the data comes from. the fetch helper maps query state into presentation state. keep the library's error types and behavior during background refetches.

```tsx
// @ts-expect-error conflicting data owners
<Members teamId="team-123" members={[]} />;
// @ts-expect-error missing data owner
<Members />;
```

types reject conflicting inputs. they don't stop a network request. test that promise, and check whether data is present rather than truthy.

`MembersView` only renders its inputs. it doesn't fetch, choose a route, or open a shell. putting query hooks in `FetchedMembers` avoids conditional hooks when the caller switches data sources.

```tsx
// caller owns filtering; the feature still owns how members look
<Members members={allMembers.filter(member => member.role === 'admin')} />

// caller owns asynchronous state too: use the presentation directly
<MembersView state={{ status: 'loading' }} />
<MembersView state={{ status: 'error', error }} />
<MembersView state={{ status: 'ready', members: [] }} />
```

`[]`, `0`, and valid empty text are data. don't treat them as missing. a disabled query's pending/error flags must not hide supplied data either. if you still need to fetch metadata, say so in the contract; don't promise a fetch-free render.

you don't need three public layers. keep the fetch helper private unless a caller needs it. add `<MembersFromQuery query={result} />` only when it removes repeated mapping or workflow code. a supplied resource, store, or query result must not cause another query. use separate component names if a combined API makes ownership unclear.

## requests follow input; responses don't rewrite intent

```tsx
const [scope, setScope] = React.useState<'mine' | 'all'>('mine');
const [search, setSearch] = React.useState('');
const query = useQuery(membersQuery({ teamId, scope, search }));
```

typing changes `search`, not `scope`. a late response must not select a tab or erase a draft. put the query inputs in both the request and cache key. decide defaults and resets separately.

tenant, resource, query, form, and overlay IDs serve different purposes. don't reuse them blindly. two open drafts must not accidentally share preview results.

## a draft is not a query result

an editor can manage its own draft and save. a caller coordinating several edits can instead supply both to the presentation:

```tsx
// feature owns the draft and invokes the save capability
<MemberEditor mode="edit" member={member} onSuccess={handleSaved} />
<MemberEditor mode="create" onSuccess={handleCreated} />

// caller coordinates this form with other editable content
<MemberForm value={draft} onChange={setDraft}
  saveState={saveState} onSubmit={saveAllChanges} />
```

create starts from defaults or an initial draft. edit needs an existing member. make that distinction explicit. decide what a refetch does to dirty input, and whether switching members resets, asks for confirmation, or remounts the editor.

loading, failure, empty data, and permission denial are different states. so are a pending save and a failed save. if data needed for validation fails to load, don't treat it as an empty successful result.

## keep the behavior when you move the UI

**check when queries run.** the request and key must agree on tenant, filters, pagination, and preview inputs. hiding mounted UI does not disable its query.

**close on the right outcome.** when the caller wants it, close after a successful save or cancel—not `onSettled`, which also runs after failure. keep errors and drafts available for retry. explicit cancel may differ from Escape or outside-click dismissal. a callback failure is not necessarily a persistence failure.

**don't overwrite effects.** `{ ...options, onSettled: close }` replaces the old handler. use the data library's callback composition to keep required invalidation, schema events, optimistic rollback, notifications, and onboarding. keep their order. don't impose “always invalidate on settled.”

**test the actual shell.** check promised layout/style slots, refs, ARIA, and handlers. try bounded height, scrolling, focus, portals, secondary overlays, and repeated instances. accepting a footer style and dropping it breaks the caller's layout control.

## build it, then try to break it

start with the callers, data/query/mutation contracts, supported states and shells, and compatibility requirements. a review request is not permission to edit.

1. read the existing behavior, including effects after save or failure.
2. write the consumer calls and invalid calls.
3. extract shared presentation without changing behavior. make behavior changes separately.
4. check the data paths and real shells. leave the examples, ownership rules, and test results; name anything blocked.

test cases that distinguish working composition from a convincing API:

- render both data modes in a page and tooltip for display, or a page and drawer for editing. check the ID query, no duplicate fetch for supplied data, and the same presentation.
- compile valid ID/data calls. reject conflicting inputs, neither input, ready-without-data, and edit-without-member.
- supply `[]` or `0` with a cold cache. fail on a request or unexpected placeholder. then supply only an ID to catch a fix that disables every query.
- reject a save, then return a resolved conflict. neither may trigger success or dismissal. retain the draft and show the failure. check actual invalidation, events, and rollback—not just callback spies.
- use only documented providers. try narrow containers and repeated instances. check forwarded styles/ref/ARIA, nested focus, and dismissal. a skipped UI test or manager-call spy doesn't test these.
- type while a request resolves. scope and dirty input must stay unchanged. check create/edit, switching A → B, and concurrent previews where relevant.

changing a submit button is API customization, not a reason to extract a data layer. static components don't need fetching. separate display/fetch components are fine; one overloaded entry point is optional.

stop when the requested behavior is checked, or name the blocker. report commands and results. inspect changed appearance and test interactions. props, types, or screenshots alone don't prove that a feature “works anywhere.” leave API customization, concurrency tuning, complex workflows, quality ratchets, migrations, and publishing evidence to their own work.

## evidence and recommendations

the source examples demonstrate page/drawer reuse, exclusive ID/data types, explicit resources, and caller-owned outcomes. they also supply the failure cases to check. shared controlled cores and the broader test cases are recommendations, not claims that every source follows them. where examples conflict, preserve retry and cache behavior rather than copying a close-on-settled handler or a library-specific invalidation rule.
