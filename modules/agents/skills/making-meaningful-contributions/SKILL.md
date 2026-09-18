---
name: making-meaningful-contributions
description: Reviews code changes and pull requests for proven correctness, honest abstractions, meaningful edge coverage, and reviewer-ready evidence. Use before submitting or reviewing implementation work.
---

# meaningful contribution

Based on embarassing feedback on a bad PR for AXM-10598, and written from my beliefs; with only a little bit of copy pasting, because to be human is to copy from a shitload of places until it becomes your own.

## A contribution is not code, it's proven working code

> "your job is to deliver code you have proven to work." — [simon willison](https://simonwillison.net/2025/Dec/18/code-proven-to-work/)

agent-generated code is cheap. anyone can prompt an LLM to produce a thousand-line patch. that's not valuable. what's valuable is contributing code that demonstrably works, has been tested, and doesn't shift burden to reviewers.

## what qualifies as meaningful

### 1. proven correctness

if you haven't tested it, it doesn't work.
if it happens to work, that's luck.

to actually prove something works, we:

- you tested manually, and saw it work.
- you wrote an automated test for what you did manually.
- you saw this automated test fail when you reverted you change.
- you tested the edges, you explicitly defined what happens outside the happy path.

### 2. self-consistent abstractions

you created a mental model, great,
does it make sense when you look closer?
does it fit with the wider mental model?

naming something `VersionedStructuredRequestWithOptions` and then passing unversioned requests through it is confusing. names are contracts.

i don't know how to prove that something makes sense, but a good start is:

- you can explain it in plain english; from start to finish, and each part in isolation.
- you can explicitly articulate the expected inputs and outputs, and what happens if one of those is unexpected.

## what doesn't qualify

### slop indicators

- PR descriptions that read like "summarize this for me" prompts
- missing tests
- contradictions in abstractions, both against themselves and against the wider context.
- names that lie about what they contain, if you need a comment or "x but it's actually y or x+y", its lying.

### the speed trap

speed without quality is negative value. a sloppy PR costs more reviewer and maintenance time than it saves. the "i'll fix it later" debt compounds negativelly, the "i made it well" value compounds positivelly.

> we lost track of the goal. we sacrificed quality in pursuit of speed, and for what?

## the review standard

ask yourself before submitting:

1. have i seen this work? not "does the code look right"—have i actually run it?
2. do the types tell the truth? or am i lying to the compiler and hoping reviewers don't notice?
3. is the naming honest? would someone reading this in six months be confused?
4. did i test the edges? what happens when usage deviates from the happy path? when it's the WORST path?
5. would i be confident to walk colleagues through my changes?

if the answer to any of these is "no" or "i'm not sure," the contribution isn't ready.

## agent-assisted work requires more scrutiny, not less

agents make it easy to produce large volumes of code quickly. this doesn't reduce your responsibility—it increases it. the code still has your name on it.

one pass from an agent is rarely enough. read it over. improve it. run it. test it. do this multiple times if needed.

## the accountability loop

a computer can never be held accountable. that's your job as the human. almost anyone can generate a thousand-line patch. what's valuable is proving it works.

next time you submit a PR, include the evidence.
