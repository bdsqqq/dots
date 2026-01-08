# meaningful contribution

## a contribution is not code, it's proven working code

> "your job is to deliver code you have proven to work." — simon willison

agent-generated code is cheap. anyone can prompt an LLM to produce a thousand-line patch. what's valuable is code that demonstrably works, has been tested, and doesn't shift burden to reviewers.

## what qualifies as meaningful

### 1. proven correctness

if you haven't tested it, it doesn't work. if it happens to work, that's luck.

- you tested manually and saw it work
- you wrote an automated test
- you saw the test fail when you reverted the change
- you tested the edges

### 2. self-consistent abstractions

- you can explain it in plain english, start to finish
- you can articulate expected inputs/outputs and edge cases
- names are contracts—don't lie

## slop indicators

- PR descriptions that read like "summarize this for me" prompts
- missing tests
- contradictions in abstractions
- names that lie about what they contain

## the review standard

before submitting:

1. have i seen this work? not "does the code look right"—have i actually run it?
2. do the types tell the truth?
3. is the naming honest?
4. did i test the edges?
5. would i be confident walking colleagues through my changes?

if any answer is "no" or "i'm not sure," it's not ready.

## agent-assisted work requires more scrutiny, not less

one pass from an agent is rarely enough. read it. improve it. run it. test it. repeat.
