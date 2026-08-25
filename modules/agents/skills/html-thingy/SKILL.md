---
name: html-thingy
description: Creates or revises a self-contained HTML file for plans, specs, write-ups, findings, summaries, reports, comparisons, and UI mocks. Use when the user asks to make something visual, says “html,” or says “make this into an html thingy.”
---

# html thingy

turn material that benefits from spatial structure into one self-contained HTML file, then place it at the requested path.

## artifact

- use the destination given by the user; otherwise default to `~/commonplace/01_files/html_stuff/<stable-slug>.html`
- revise the same file across iterations unless the user requests another destination
- keep it self-contained and at most 512 KB: inline CSS and JavaScript, with no external runtime or asset dependency
- preserve source links and distinguish evidence from inference
- do not open a browser unless requested

## composition

write a dense working document, not a landing page:

- lead with the conclusion, decision, or model
- turn relationships into grids, timelines, flows, matrices, and annotated diagrams
- use prose where sequence and qualification matter; do not make every sentence a card
- label directly comparable UI alternatives `a`, `b`, `c`, and show them together
- include concrete constraints, edge cases, and unresolved questions
- use semantic HTML, responsive layouts, visible keyboard focus, and reduced-motion support

default visual system:

- true black `#000` background and white `#fff` primary text
- dark-gray secondary surfaces and restrained borders
- one or two semantic accents only
- compact typography with strong hierarchy
- no gradients, decorative glass effects, or gratuitous animation

adapt the system when the content or user requests another direction. the information model matters more than house style.

## workflow

1. inspect the relevant sources and identify the artifact’s audience, decision, and information hierarchy.
2. resolve the destination. choose a stable lowercase kebab-case filename only when the user did not provide one.
3. ensure the destination directory exists. author the complete document at a temporary `.html` path in that same directory, with a descriptive `<title>` and optional `<meta name="description">`.
4. rename the completed temporary file over the destination atomically. do not leave drafts beside the final artifact.
5. report the exact destination path.

## boundaries

- stop after placing the file and reporting its exact path
- do not start unrelated tools or workflows
- reading an existing page is ordinary web research; do not invoke this authoring workflow unless the user also wants an HTML file created or revised
