---
name: document
description: apply documentation philosophy — explain why, not what. use for jsdocs, READMEs, inline comments.
---

# document

apply documentation philosophy: explain why, not what.

## when to use

- writing jsdocs for components or functions
- updating README or project docs
- adding inline comments during implementation
- reviewing existing documentation for cleanup

## workflow

1. check if documentation is needed — if it describes obvious behavior, skip it
2. identify the non-obvious why: design constraints, behavioral consequences, inheritance warnings
3. write terse, lowercase prose
4. delete anything that merely restates the code

## quick reference: why over what

**delete this:**
```typescript
/** context provider that wraps children in a DisclosureProvider. */
```

**keep this:**
```typescript
/**
 * blocks CompositeContext so nested Lists create isolated focus loops.
 * essential for "Simple API" goal — our List is "greedy" and would
 * otherwise join parent's arrow-key navigation.
 */
```

## what to document

- design rationale and constraints
- context shadowing / inheritance warnings
- non-obvious behavioral consequences
- internal decisions affecting correctness

## what to delete

- obvious behavior ("renders a button")
- what the function name already says
- what types already express

## tone

- lowercase only (ALL CAPS for emphasis)
- terse, no unsupported claims
- specific over general; describe, don't emote

## reference

see [references/05-documentation-philosophy.md](references/05-documentation-philosophy.md) for full patterns and examples.
