---
name: explaining-with-animations
description: "Explain how something works through concrete examples and causal visual sequences. Use for bottom-up visual explanations, explainer videos, motion graphics explaining architecture or usage, interactive walkthroughs, or static step-by-step diagrams; not for ordinary short answers, UI motion polish, or decorative animation."
---

# explaining with animations

build a mental model the learner can run themselves. the teaching method is shared; the delivery medium follows the request.

## build from the smallest useful model

1. identify the learning goal and inspect the supplied sources: documentation, research notes, code, or a lecture. for code or systems, trace the relevant operation before illustrating it. separate observed behavior, teaching simplifications, and unknowns.
2. choose one small, concrete example that survives the explanation: three items, a single request, two people, a few bytes. show its starting state and what each visible object means. a simple system overview can orient an architecture explanation; omit machinery the example does not need. avoid a terminology dump or a metaphor that needs its own explanation.
3. sketch a short sequence of states. each step answers **what changed, what caused it, and what can happen next?** introduce one idea at a time and name an abstraction after showing the need for it. choose the visual treatment and production tools to serve that sequence, not the other way around.
4. apply the same mechanism to a different input or a revealing failure. show what stays true and where the simplified model stops applying. when teaching a tool or system, connect the mechanism to one concrete usage example.

ask only when missing information materially changes the explanation. otherwise use the supplied sources and requested format; do not turn a simple brief into a production questionnaire.

## make causality visible

- keep objects, labels and positions stable across states. distinguish a copy from a move, a message from its recipient, and a request from its acknowledgment.
- expose relevant values before and after a change. use short captions such as “the value is still only in ram; this acknowledgment does not prove it reached disk.”
- use arrows for actual travel or causal dependency, not decoration. a highlight means attention, not data movement. do not invent serialized timing for concurrent work; label a chosen ordering as one possible trace.
- prefer simple labeled shapes when they suffice. use supplied assets or illustrations when they clarify the subject; do not make branding or image gathering a prerequisite. color reinforces a distinction already expressed by text or shape.
- give consequences room to register. where useful, let the learner predict the next state before revealing it. finish with what the example now lets them explain, not more terminology.

**contrast:** “first learn consistency, durability and replication” gives names without a mechanism. instead, show one value entering ram, an early acknowledgment, a crash, and the missing value; then name the distinction. make clear that this is the inspected system or a declared toy model, not every database.

## match delivery to the medium

keep the causal sequence independent of its presentation. animate only changes that aid understanding; do not make a claim depend on catching a fleeting effect. follow an explicitly requested medium. otherwise choose the simplest supported form that meets the learning goal.

- **interactive walkthrough:** default to reader-paced steps, with previous, next, replay and reset controls plus a step count. each selected step must produce a complete, deterministic state; navigation cannot accumulate stale objects, timers or values. support keyboard use, visible focus, narrow screens and reduced motion without losing causal information. for a self-contained page, reuse [html-thingy](../html-thingy/SKILL.md).
- **video:** storyboard the causal sequence, then time scenes so labels and consequences remain readable. if narration is requested, align it with the visible event and retain key explanations in captions or on-screen text. render the requested video; an interactive page or storyboard is not a substitute. use the available production tools without imposing a particular framework.
- **static sequence:** use numbered panels with consistent objects and explicit before/after values. captions and arrows must carry the causal links without relying on motion.

if the requested medium cannot be produced, report the limitation and offer a labeled storyboard or another supported format. do not call prose an animation or an unrendered project a finished video.

## check the explanation, not just the file

inspect the complete rendered sequence and compare values, object identity, causal claims and usage examples against the sources or declared toy model. can a newcomer tell what exists, what changed and why? remove unexplained machinery or split a step rather than adding jargon. retain useful distinctions even when they complicate the story.

check the relevant delivery path:

- **interactive:** exercise backward navigation, replay and reset midway and at the end; check keyboard access, reduced motion and a narrow viewport.
- **video:** play the rendered output; inspect scene transitions, text readability and holds, plus narration/caption alignment when present. a successful render alone does not establish these worked.
- **static:** inspect the rendered panels in reading order and verify that every causal link is understandable without animation.

report what was actually inspected and any untested behavior or platform. stop once the learning goal is met and the requested artifact is delivered; do not expand into a course or publish externally without authorization.
