# documentation philosophy

extracted from amp jsdoc style guide and voice standards.

## core principle: only document the non-obvious why

documentation should explain rationale and design constraints, not describe what code does. if it simply describes behavior, delete it.

### what to document

- design rationale and constraints (why a choice was necessary)
- context shadowing and inheritance warnings
- non-obvious behavioral consequences
- css variables and configuration options
- internal decisions that affect correctness

### what NOT to document

- obvious behavior ("renders a button" for a Button component)
- implementation details users don't need to know
- what the function name already tells you
- descriptions that could be inferred from type signatures

## the pattern: why over what

bad example (describes what):
```typescript
/**
 * context provider that wraps children in a DisclosureProvider.
 * provides open, closed, and setOpen states.
 */
```

good example (explains why):
```typescript
/**
 * blocks the CompositeContext so nested Lists create their own isolated focus loops.
 *
 * used internally by FloatingContent to ensure popover menus don't join
 * the parent's arrow-key navigation.
 *
 * this is essential for our "Simple API" goal.
 * our `List` component is "greedy"—if it sees a parent `CompositeContext`, it joins it.
 * by blocking the context here, we force the nested `List` to see `null`, triggering it
 * to create its own fresh `CompositeStore` (and thus its own isolated focus loop).
 */
```

the second explains *why blocking exists* and its consequence for the system. that's worth documenting.

## tone and voice

### formatting

- **lowercase prose ONLY** — no sentence case, title case, or capitalization
- ALL CAPS only for emphasis (rare)
- Initial Letter Capitalization reserved for sarcasm toward capitalized nouns
- be terse while conveying substantially all relevant information

### content rules

- make no unsupported claims. if you can't defend it, delete or label as hunch
- avoid absolutist language. prefer "a problem" to "the problem"
- be precise and specific; describe, don't emote
- avoid hyperbole; adjectives should clarify, not persuade
- critique freely, avoid sycophancy

## when to preserve internal notes

keep `@bdsqqq notes` or similar inline comments when they explain non-obvious decisions that users of the code should know:

```typescript
/**
 * connector line component.
 *
 * @bdsqqq notes: alpha colors avoided for strokes due to compounding
 * overlap issues at intersection points.
 */
```

this tells future maintainers *why* a choice was constrained, not just what was done.

## jsdoc structure

minimal format:

```typescript
/**
 * one-line description of purpose or behavior.
 *
 * additional context if design rationale is complex (keep brief).
 *
 * @prop propName - what it does
 * @example basic usage
 * ```tsx
 * <Component>content</Component>
 * ```
 */
```

examples should show one thing and fit the pattern users already know.

## colocate context with code

jsdocs are the source of truth. external docs are pulled from code at build time (ariakit pattern). this keeps documentation fresh and forces writers to explain *why* to future maintainers reading the code.

upon finishing a task, colocate valuable context as jsdocs with the code. only keep notes that explain non-obvious why; delete everything else.
