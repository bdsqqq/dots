---
name: designing-progressive-apis
description: "Designs type-safe APIs with useful defaults and room for caller control. Use for overloads, render slots, compound parts, and controlled state. Does not cover fetching or host lifecycle."
metadata:
  archetype: pattern-matching
---

# designing progressive APIs

let callers change one thing without rebuilding everything else.

this skill covers what callers can replace and how types guide them. it does not make a feature independent of its page or fix duplicate fetching. those are data and lifecycle problems.

## start with the calls you want people to write

```tsx
// use the feature
<Signup />

// own one element, not submission or the surrounding layout
<Signup renderSubmit={props => <BrandButton {...props} />} />

// own the structure, not the form's behavior
<Signup>
  <Signup.Form>
    <Signup.Errors />
    <Signup.Email />
    <Signup.Submit />
    <Signup.Status />
  </Signup.Form>
</Signup>
```

build the default from the same parts callers can use. changing the markup should keep validation, submission, and errors working. each replacement you support is another path you must test.

these TypeScript/React examples show the choices. use the codebase's primitives; don't add every level of control just because you can.

## give callers only the control they need

ask what the caller needs to change:

| need | hand over | leave owned by the feature |
| --- | --- | --- |
| change a label, size, or class | an ordinary prop | structure and behavior |
| use a design-system button | a render slot with behavioral props | validation, submission, other elements |
| reorder or interleave content | compound parts under an explicit root | shared feature state and actions |
| coordinate state with another feature | a controlled value/change contract | presentation and supported interactions |

a label change needs a prop, not a render framework.

**markup, state, and data are separate choices.** replacing a button should not mean taking over fetching. controlling a value should not require replacing markup. use one entry point for modes of the same operation, separate names for different jobs. a bag of optional props leaves callers to guess which combinations work.

## make types explain the choices

types are often the first instructions callers read. show the valid combinations:

```tsx
type SignupProps = {
  onSuccess?: () => void;
} & (
  | { children: React.ReactElement; renderSubmit?: never }
  | {
      children?: never;
      renderSubmit?: (props: React.ComponentProps<'button'>) => React.ReactNode;
    }
);

// valid: defaults, a slot replacement, or caller-owned structure
<Signup />;
<Signup renderSubmit={props => <button {...props}>Join</button>} />;
<Signup><Signup.Form /></Signup>;

// invalid: who owns the submit element, the children or the slot?
// @ts-expect-error mutually exclusive composition modes
<Signup renderSubmit={props => <button {...props} />}><Signup.Form /></Signup>;
```

if a supplied prop identifies the mode, use an exclusive union as above. otherwise give the mode a name and tie its values and callbacks together:

```ts
type SelectionProps<T> =
  | { mode: 'single'; value: T | null; onChange: (value: T | null) => void }
  | { mode: 'multiple'; value: readonly T[]; onChange: (value: readonly T[]) => void };
```

checking `mode` must narrow both `value` and `onChange`. separate unions such as `value: T | T[]` and `onChange: (value: T | T[]) => void` lose that relationship. they allow mismatched pairs and force callers to handle modes they never chose.

use function overloads when different inputs produce different output types. use a union parameter when the output type stays the same. infer generics from inputs and test real calls. don't make an incompatible API compile with `any` or assertions.

check `strictNullChecks` and `exactOptionalPropertyTypes`. without exact optional properties, `prop?: never` can still accept explicit `undefined`. runtime dispatch must agree with the types. JavaScript callers and external input can bypass them. `0`, `false`, and valid empty text are not missing values.

if input needs runtime validation, derive its type from the schema so the two cannot drift. conflicting modes must fail both checks. internal component props don't all need schemas.

## replacing an element must not break its behavior

```tsx
<Signup.Email render={(props, state) => (
  <BrandInput {...props} aria-invalid={Boolean(state.errors?.length)} />
)} />
```

pass names, values, handlers, refs, ARIA, state, and promised layout/style slots to the right element. follow the primitive's rules for merging refs and cancelling events. overwriting a handler can silently remove validation or keyboard support.

keep required inputs and effects working. giving a render callback access to state does not let the caller control that state:

```ts
type DisclosureProps =
  | { open: boolean; onOpenChange: (open: boolean) => void; defaultOpen?: never }
  | { defaultOpen?: boolean; open?: never; onOpenChange?: (open: boolean) => void };
```

when the caller supplies `open`, follow it. `defaultOpen` only initializes private state. say whether switching between controlled and uncontrolled is supported after mount. `false` is a value, not a request for the default.

parts can share state under a root such as `<Signup>`. say which parts need the root, report a missing root clearly, and keep separate instances separate. you don't need to pass every internal value through props.

## build it, then try to break it

start with real callers, what they need to change, and the existing primitives. check what must stay compatible. a design or review request is not permission to edit.

1. write the default call and the customized call first. state what the feature still handles.
2. test calls that should compile and calls that should fail. check missing requirements, conflicting modes, and callback inference without casts.
3. build defaults from the exposed parts. add customization only when a caller needs it.
4. test the replacements, not just the default. if the UI changes, inspect its rendered appearance and test its interactions.

leave consumer examples, the typed API, the smallest implementation or review findings, and the checks you ran. report anything you could not verify.

use cases that can catch a wrong implementation:

- default signup and custom-submit signup send the same payload and report the same outcome. reordered parts still show errors.
- conflicting children/slot props fail compilation. single selection rejects an array callback; multiple selection infers an array. loosen the union in a disposable copy: the negative tests must fail, for example with unused `@ts-expect-error` directives.
- replace an element and check its inputs, effects, refs, ARIA, and handlers. deliberately drop a required input or handler; the test must catch it.
- change controlled `open` from true to false. the UI follows it, regardless of `defaultOpen`. two roots do not share state.

don't use this to turn a badge's alternate label into a compound-component framework. unrelated operations don't need one entry point because both return JSX. a typed ID/data component that fetches despite supplied data needs a data-ownership fix, not another overload.

stop when the requested calls work, invalid calls fail, and behavior is checked—or name the blocker. these are design recommendations. query/cache policy, host lifecycle, workflow orchestration, migrations, inventories, cleanup, and publishing evidence are separate jobs.
