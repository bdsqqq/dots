---
name: write
description: "Compose or edit substantial prose: documentation, proposals, reports, articles, and PR descriptions. Use for prose craft, not routine chat, short status updates, exact lookups, or code-only changes."
---

# write

turn source material into prose a reader can act on. global guidance owns voice
and evidence policy; this skill supplies the editing procedure.

## procedure

1. identify the reader, their next decision, and the artifact requested. infer
   these when clear; ask only when the answer changes the work.
2. lead with the conclusion or changed behavior. retain only the context needed
   to understand why it matters.
3. organize around the reader's questions, not the order work happened. use
   headings for longer arguments, not as mandatory ceremony.
4. replace evaluations with mechanisms or observations. preserve qualifications
   that change the claim; remove hedges that merely avoid saying it.
5. put durable rationale beside the contract it explains: a nearby comment or
   jsdoc for code, a relevant section for documentation. do not narrate obvious
   syntax or leave scratch investigation notes as permanent documentation.
6. check names, quotations, numbers, and links against supplied sources. credit
   borrowed ideas inline; distinguish an author's recommendation from measured
   results. never invent a measurement to make a sentence concrete.
7. cut repetition, throat-clearing, and self-congratulation. read the result once
   as the intended reader: can they find the conclusion and remaining limitation?

drafting text does not authorize publishing it, editing files outside the
requested scope, or committing it.

## contrastive examples

these are illustrative rewrites, not evidence of a particular change.

### pr description

**before:**

```text
## Summary
This PR fixes an important bug in the authentication flow where the dialog
wasn't closing properly after token creation.

## Changes Made
- Added missing dialogManager.close(id) call to the success path
- This ensures consistent behavior with the cancel path

## Testing
Manually verified the dialog now closes correctly.
```

**after:**

```text
dialog stayed open after token creation. now it closes.

onNewTokenSubmit called onSuccess but skipped dialogManager.close(id).
the close call now runs before onSuccess, matching onCancel.

checked: creating a token closes the dialog; cancel still closes it.
not checked: token-creation failure.
```

the rewrite replaces praise and vague verification with behavior and a bounded
check. include those checks only if they actually ran.

### sentence transforms

| before | after | reason |
|---|---|---|
| "This is the best approach" | "this avoids a second database lookup" | identify the mechanism |
| "It's important to note that..." | delete the preamble | surface the point |
| "This will significantly improve latency" | "removes one network round trip; latency not measured" | do not invent a result |
| "I've successfully implemented..." | "the handler now closes the dialog" | describe the change |
| "It might potentially be somewhat useful" | state the condition under which it helps | preserve uncertainty, not fog |

### attribution

**before:** "parallel agents make investigations faster."

**after:** "poteto's [delegation brief](https://github.com/cursor/plugins/blob/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/skills/poteto-mode/playbooks/orchestrate.md#L38-L56)
specifies scope, acceptance, and a timebox. we use those fields to bound delegated
work; this does not establish a speed improvement here."

## final pass

- does the opening answer the reader's question?
- can each paragraph justify its place?
- are rationale and limitations beside the claims they qualify?
- are source credit and actual verification preserved after shortening?
