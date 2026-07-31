---
name: html-thingy
description: Creates or revises a self-contained HTML artifact for plans, specs, write-ups, findings, summaries, reports, comparisons, and UI mocks. Use when the user asks to make something visual, shareable, hosted, or says “html” or “make this into an html thingy.”
compatibility: Requires Python 3. Local hosting uses Tailscale when available and tmux for persistence.
---

# html thingy

turn material that benefits from spatial structure into one inspectable HTML file.

## artifact

- write hosted artifacts to `~/commonplace/01_files/html_stuff/<stable-slug>.html`
- honor a user-named path, but treat paths outside `html_stuff` as local-only unless the user authorizes another hosting setup
- revise the same file across iterations; changing the slug breaks its stable URL
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
2. choose a stable lowercase kebab-case slug. reuse an existing matching artifact rather than creating versions.
3. author the complete HTML file with a descriptive `<title>` and optional `<meta name="description">`.
4. structurally lint before serving:

   ```bash
   python3 ~/.config/agents/skills/html-thingy/scripts/html_stuff_server.py \
     --validate ~/commonplace/01_files/html_stuff/<slug>.html
   ```

5. derive the host address with `tailscale ip -4`, falling back to `127.0.0.1`. request the exact artifact URL. if it is unreachable, replace only the dedicated server session:

   ```bash
   tmux kill-session -t html-stuff 2>/dev/null || true
   tmux new-session -d -s html-stuff \
     'python3 ~/.config/agents/skills/html-thingy/scripts/html_stuff_server.py'
   ```

6. request the exact artifact URL again and confirm HTTP 200 before claiming it is hosted. percent-encode filenames when needed.
7. report the file path and URL. mention that access requires the host Mac and, when applicable, the same tailnet.

the server binds to this machine’s Tailscale IPv4 address when available, otherwise localhost. its generated index at `/` and `/index.html` lists artifact titles by modification time. htmx is intentionally unnecessary: the server already owns filesystem discovery and renders fresh state on every request.

## boundaries

- placing a file in `html_stuff` makes it visible to devices that can reach the server
- do not expose the server publicly, change its bind address, or copy artifacts to a public host without explicit authorization
- do not describe a written file as hosted until the server and exact URL have both been verified
- reading an existing hosted page is ordinary web research; do not invoke this authoring workflow unless the user also wants an artifact created or revised
