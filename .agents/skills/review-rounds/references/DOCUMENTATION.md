# documentation philosophy

## core principle: only document the non-obvious why

documentation should explain rationale and design constraints, not describe what code does. if it simply describes behavior, delete it.

### what to document

- design rationale and constraints (why a choice was necessary)
- context shadowing and inheritance warnings
- non-obvious behavioral consequences
- internal decisions that affect correctness

### what NOT to document

- obvious behavior ("renders a button" for a Button component)
- implementation details users don't need
- what the function name already tells you
- descriptions inferable from type signatures

## the pattern: why over what

bad (describes what):
```typescript
/**
 * context provider that wraps children in a DisclosureProvider.
 * provides open, closed, and setOpen states.
 */
```

good (explains why):
```typescript
/**
 * blocks the CompositeContext so nested Lists create their own isolated focus loops.
 *
 * used internally by FloatingContent to ensure popover menus don't join
 * the parent's arrow-key navigation.
 */
```

## content rules

- make no unsupported claims. if you can't defend it, delete or label as hunch
- avoid absolutist language. prefer "a problem" to "the problem"
- be precise and specific; describe, don't emote
- avoid hyperbole; adjectives should clarify, not persuade
