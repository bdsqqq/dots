---
name: explaining-with-animations
description: "Explain a concept hyper-intuitively, bottom-up, through simple step-by-step animations and concrete examples. Use when the user asks to really understand how something works through animated explanation, visual intuition, or a tiny interactive walkthrough; not for ordinary short answers, UI motion polish, or decorative animation."
---

# explaining with animations

make the mechanism feel inevitable, one small visible change at a time. the goal is a mental model the reader can run themselves, not an impressive animation.

## build from the smallest real thing

1. identify the exact question and inspect its source material. for code or systems, trace the actual operation before illustrating it. separate observed behavior, a teaching simplification, and anything unknown.
2. choose one tiny, concrete example that survives the whole explanation: three items, a single request, two people, a few bytes. show its starting state and what each visible object means. do not open with a wall of architecture, terminology, or a metaphor that needs its own explanation.
3. write a short sequence of states before animating. each step answers **what changed, what caused it, and what can happen next?** change one idea at a time; split a step if it needs two explanations. introduce an abstraction's name only after the reader has seen the need for it.
4. end by applying the same mechanism to a slightly different input or a revealing failure. show what stays true. connect the concrete example back to the real system and state where the simplified model stops applying.

ask a question only when the missing topic or source materially changes the explanation. otherwise start at the concrete foundation; do not make the reader pass a vocabulary quiz first.

## make causality visible

- keep objects, labels and positions stable between steps. move the same object rather than replacing it with an unrelated picture. distinguish a copy from a move, a message from its recipient, and a request from its acknowledgment.
- expose the relevant value before and after a change. use short captions such as “the value is still only in ram; this acknowledgment does not prove it reached disk.”
- show arrows only when something actually travels or one event enables another. a highlight means attention, not data movement. do not invent serialized timing for concurrent work; label a chosen ordering as one possible trace.
- prefer a few labeled rectangles, dots and numbers to illustrations, dashboards or ornamental motion. color reinforces a distinction already expressed by text or shape.
- pause at a consequence. let the reader predict the next state, then reveal it. finish with a compact “now you can explain why…” recap, not more terminology.

**contrast:** “first learn consistency, durability and replication” gives names without a mechanism. instead, show one value entering ram, an early acknowledgment, a crash, and the missing value; then name the distinction the reader just observed. make clear that this trace describes the inspected system or a declared toy model, not every database.

## animation and interaction contract

- default to reader-paced steps, not autoplay. provide visible **previous**, **next**, **replay step**, and **reset** controls plus a step count. a static initial state must already make sense.
- separate the sequence's logical states from its motion. selecting a step always produces the same complete state; going backward or resetting cannot accumulate stale objects, timers or values.
- animate only the transition being explained. make each transition short and legible, then hold its final state indefinitely. do not make the explanation depend on catching a fleeting effect.
- support keyboard operation, visible focus, readable captions and small screens. reduced-motion mode must retain every state and causal explanation, replacing travel effects with immediate changes or restrained fades.
- use the simplest supported medium. when an interactive page is appropriate, reuse [html-thingy](../html-thingy/SKILL.md) for a self-contained file rather than adding a framework or external asset dependency. use the host's preview/render tools when available; otherwise report the file path. if animation cannot be produced, say so and offer a numbered storyboard, not prose labeled as an animation.

## check the explanation, not just the file

inspect the rendered sequence from start to finish. exercise previous, replay and reset midway and at the end; verify values and object identity against the source or declared toy model. check keyboard access, reduced motion and a narrow viewport. a parsed file or recorded video alone does not establish that these worked.

read every caption with the animation paused: can a newcomer tell what exists, what just changed and why? remove unexplained machinery or split the step rather than adding a paragraph of jargon. retain a useful distinction even when it complicates the story; do not animate a false mechanism to make the explanation smoother.

report what was actually inspected and any untested interaction or platform. stop once the concrete causal sequence is understandable and the requested artifact is delivered; do not expand into a generic course or publish it externally without authorization.
