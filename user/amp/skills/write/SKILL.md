---
name: write
description: "technical prose style guide. use when writing docs, READMEs, PR descriptions, essays, or any prose meant for developer audiences. enforces academish voice: supported claims, precise language, no hyperbole."
---

# write

style guidance for technical prose. follows academish voice—academic rigor without academic density.

## when to use

- writing or reviewing documentation
- drafting PR descriptions or commit messages  
- composing READMEs, essays, technical blog posts
- any prose targeting developer/technical audiences

## core principles

read `references/academish-voice.md` for full guidance. summary:

**claims need support** — if you can't defend it, delete it or label as hunch  
**precision over persuasion** — describe, don't emote. "a problem" not "the problem"  
**no hyperbole** — adjectives clarify, not sell. delete emphasis-only words  
**structure for skimming** — surface goals/conclusions early. headings as roadmap  
**credit sources** — cite, link, thank contributors  
**humble about solutions** — enthusiastic about goals, modest about implementations  
**explain jargon** — gloss uncommon terms for generalist readers

## workflow

1. **draft** — get ideas down, don't self-edit yet
2. **structure pass** — ensure lede isn't buried, headings communicate shape
3. **claims pass** — audit each claim. can you defend it? cite it or cut it
4. **precision pass** — replace vague language with specifics
5. **tone pass** — remove hyperbole, ensure appropriate confidence levels

## self-review checklist

before submitting, verify:

- [ ] no unsupported claims (or labeled as hunches)
- [ ] no absolutist language without justification
- [ ] adjectives add precision, not persuasion
- [ ] goals/conclusions visible early
- [ ] jargon explained or glossed
- [ ] sources credited
- [ ] shortcomings acknowledged
- [ ] no dismissive language about other work

## sentence transforms

| before | after | why |
|--------|-------|-----|
| "This is the best approach" | "This approach avoids X and Y" | justify, don't rank |
| "It's important to note that..." | [delete the phrase] | throat-clearing adds nothing |
| "basically", "obviously", "simply" | [delete] | dismissive; if obvious, don't say it |
| "This will significantly improve..." | "This reduces latency by ~40ms" | quantify or cut the adjective |

## anti-patterns

**the buried lede** — three paragraphs of context before stating the point. fix: state conclusion first, then support.

**the hedge stack** — "It might potentially be somewhat useful in certain cases." fix: commit or cut.
