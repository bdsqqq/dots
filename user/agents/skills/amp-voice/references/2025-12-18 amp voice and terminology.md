# amp voice and terminology

a comprehensive language guide derived from amp's manual, blog posts, news articles, FIF, how we build, and other documentation.

---

## voice characteristics

### tone
- **direct and casual**: no marketing speak, no buzzwords like "core capabilities" or "seamless integration"
- **technical but accessible**: explains concepts clearly without condescension
- **opinionated without arrogance**: "we think this works better" rather than "this is the only way"
- **self-aware humor**: "thinks" (in airquotes), agents getting "drunk" on too many tokens, "superpowered alien orb made of sand"
- **honest about limitations**: admits when things are "rough" or have "warts", openly discusses model imperfections
- **no emojis** in UI or official communications
- **lowercase preference** in casual internal communication

### sentence structure
- short, punchy sentences
- declarative statements over hedging
- "do X" over "you might want to consider X"
- concrete examples over abstract explanations
- rhetorical questions used effectively: "isn't this amazing?" "wait, is everything changing... again?"

### philosophy expressed in voice
- "if we don't use and love a feature, we kill it"
- "ship, use, iterate"
- "hours and days over weeks and months"
- "less is more"
- "no magic" — avoid solutions that infer intent behind the scenes
- "staying on the frontier means sometimes shipping despite issues — and sometimes shipping something better a week later"
- "the emperor has no clothes" — there's no secret sauce, just practical engineering and elbow grease
- "dogfooding is a superpower"
- "prototypes over RFCs and discussions"

### characteristic phrases
- "everything is changing"
- "the frontier"
- "token by token"
- "elbow grease"
- "mini-Amps"
- "we'd prefer one standard"
- "happy hacking"
- "mise-en-place" (cooking reference for setup)
- "squint and you'll see"
- "that's it. truly: that's it."

---

## core terminology

### threads
the fundamental unit of work. NOT "conversations" or "chats" or "sessions."

- **thread**: a conversation with the agent; the context window made visible
- **short threads are best**: "agents get drunk if you feed them too many tokens"
- **one task per thread**: don't mix database migrations with CSS changes
- **threads as first-class entities**: shareable, reusable, referenceable
- **focused threads**: amp encourages focused threads over long, meandering ones

### context window
the entire input sent to the model. amp uses "thread" and "context window" somewhat interchangeably.

key concepts:
- "everything in the context window is multiplied with everything else"
- "everything counts to some extent"
- "the context window is important"
- "200k tokens is plenty" (if you use short threads)
- context can "get drunk" — too many tokens degrades quality

### thread relationships

| term | meaning | mechanism |
|------|---------|-----------|
| **handoff** | extract relevant context into a new focused thread | `/handoff <goal>` |
| **fork** | duplicate the thread at a point in history | `amp threads fork` or `f` key |
| **mention/reference** | link to another thread for context extraction | `@T-threadid` or paste URL |
| **continue** | resume an existing thread | `amp threads continue` |

### thread patterns (from thread map)

- **hub-and-spokes**: one central thread, many branches that don't need each other's context
- **chain**: linear succession of short threads, each handing off to the next
- "it's not uncommon for the end of a chain to lead to the central node of a hub-and-spokes pattern"

### thread map
- visualizes threads connected via mentions, handoffs, or forks
- shows the "shape" of your work
- accessed via `threads: map` in CLI command palette

---

## agents and subagents

### definitions
- **agent**: "an LLM with access to tools, giving it the ability to modify something outside the context window"
- **subagent**: a tool that is itself an agent; spawned by the main agent
- **mini-Amps**: casual term for generic subagents that can do anything the main agent can
- "they are agents. they can make their own decisions (again: airquotes)"

### named subagents/tools
- **oracle**: GPT-5 reasoning model for complex analysis, debugging, code review (always lowercase)
- **librarian**: subagent for searching remote codebases (github, public and private repos)
- **search agent**: specialized read-only subagent for local codebase exploration
- **finder**: semantic code search
- **look_at**: analyzes files in separate context window, returns only relevant info

### key properties of subagents
- "they each have their own context window" — this is the magic
- "multiplication of context windows"
- subagents work in isolation, can't communicate with each other
- you can't guide them mid-task
- main agent only receives their final summary

DO NOT USE:
- "servant" — too hierarchical, not in amp's lexicon
- "worker" — too generic
- "assistant" — too anthropic-product-specific
- "bot" — too 2018
- "AI" as a noun for the agent

---

## tools and extensibility

### tool categories
- **tool**: something the agent can invoke (Bash, Read, edit_file, etc.)
- **toolbox**: user-defined executable scripts that extend amp (via `AMP_TOOLBOX` env var)
- **skill**: lazily-loaded instructions for specialized tasks
- **custom command**: pre-defined or dynamically-generated prompts (formerly "slash commands")
- **MCP server**: model context protocol for external tool providers

### skill structure
- **skill directory**: `.agents/skills/` or `~/.config/amp/skills/`
- **SKILL.md**: the instruction file inside a skill directory
- skills "let the agent lazily-load specific instructions"

### toolbox pattern
- executable with `TOOLBOX_ACTION=describe` returns tool description
- executable with `TOOLBOX_ACTION=execute` runs the tool
- input via stdin, output via stdout

---

## modes

| mode | description | model |
|------|-------------|-------|
| **smart** | unconstrained state-of-the-art models (default, paid) | Claude Opus 4.5 |
| **rush** | faster, cheaper, less capable — for well-defined tasks | Claude Haiku 4.5 |
| **free** | free tier with basic models, ad-supported | various |

"a rushed job is faster and cheaper in the moment, and sometimes that's more important than quality"

### when to use rush
- small bugs, small UI changes, minor features
- "mention the files that need to be changed"
- don't use for: complex tasks, new end-to-end features, bugs with no clear diagnosis, architecture refactors

---

## files and configuration

| file | purpose |
|------|---------|
| **AGENTS.md** | project/user guidance files |
| **AGENT.md** | legacy name, still supported |
| **CLAUDE.md** | also supported for compatibility |
| **SKILL.md** | skill instruction file |
| **.agents/commands/** | custom command definitions |
| **.agents/skills/** | workspace skills |

### AGENTS.md features
- @-mentions for including other files
- `globs` frontmatter for conditional inclusion
- subtree AGENTS.md files included when agent reads files in that subtree

---

## actions / verbs

| amp term | meaning |
|----------|---------|
| **spawn** | create a new subagent |
| **handoff** | transfer focused context to a new thread |
| **fork** | duplicate thread history |
| **reference/mention** | link to a thread to pull context from it |
| **switch** | move between threads |
| **continue** | resume an existing thread |
| **restore** | reset thread to a previous message |
| **edit** | modify a previous message |
| **summon** | invoke a named subagent (e.g., "summon the librarian") |
| **invoke** | use a tool |

---

## execution modes

| mode | flag | description |
|------|------|-------------|
| **interactive** | (default) | can guide the agent |
| **execute** | `-x` or `--execute` | fire-and-forget single prompt |
| **stream-json** | `--stream-json` | machine-readable output |

"execute mode allows for programmatic use of the Amp CLI"

---

## environment variables

| var | purpose |
|-----|---------|
| `AMP_CURRENT_THREAD_ID` | current thread ID |
| `AMP_TOOLBOX` | path to toolbox directory |
| `AMP_API_KEY` | API key for headless use |
| `TOOLBOX_ACTION` | `describe` or `execute` |

---

## UI/UX terminology

- **command palette**: `Ctrl+O` / `Alt+O` — replaces slash commands
- **prompt field**: where you type messages
- **transcript**: the visible conversation history
- **thread feed**: list of threads at ampcode.com/threads
- **token usage hover**: shows context window usage percentage

---

## model evaluation language

from internal discussions:
- "warts" — known imperfections
- "rough edges" — behaviors that aren't polished
- "steerable" — model follows instructions well
- "persistent" — model keeps working until task is done
- "effusive" — model talks too much (negative)
- "terse and direct" — desirable output style
- "research loops" — model keeps reading files unnecessarily
- "gives up" — model stops before completing task

---

## anti-patterns (from FIF)

things amp explicitly rejects:
- model switcher dropdown — "building deeply into model capabilities yields the best product"
- edit-by-edit approval — "traps you in a local maximum"
- hiding agent work — "sets expectations too high"
- private-by-default threads — "shared by default results in more threads being shared"
- auto-compaction — "reduces quality and creates inconsistent experience"
- .ampignore file — "actively harmful: hiding files encourages creative workarounds"
- background process management — caused too many problems

---

## naming conventions

### for skills
based on existing amp-contrib skills:
- **tmux**: lowercase, single word
- **bigquery**: lowercase, compound
- **web-browser**: lowercase, hyphenated compound

### suggested pattern
- ~~spawn-servant~~ → **spawn** (aligns with "spawn another agent", "spawn the search agent")
- keep names short, lowercase, descriptive

---

## example phrases in amp voice

### good
- "short threads are best"
- "agents get drunk if you feed them too many tokens"
- "spawn a subagent for this task"
- "handoff to a new thread"
- "keep threads focused"
- "this is essentially all there is"
- "300 lines of code and three tools"
- "practical engineering and elbow grease"
- "everything is changing"
- "happy hacking"

### avoid
- "leverage the power of AI"
- "seamlessly integrate"
- "unlock productivity"
- "supercharge your workflow"
- "servant agent"
- "your AI assistant"
- any emoji
- excessive exclamation points
- "you're absolutely right"

---

## quotable passages

> "It's an LLM, a loop, and enough tokens. The rest, the stuff that makes Amp so addictive and impressive? Elbow grease."

> "Agents get drunk if you feed them too many tokens. I don't know how to explain it better than this — they act drunk."

> "We consciously haven't pushed the oracle too hard in the system prompt, to avoid unnecessarily increasing costs for you or slowing you down."

> "Threads as first-class entities — shareable, reusable, referenceable — has the potential to unlock new patterns for agentic programming."

> "What we want to encourage are focused threads, because we think that's how agents yield the best results."

> "Staying on the frontier means sometimes shipping despite issues — and sometimes shipping something better a week later."

> "There isn't [a secret]. It's an LLM, a loop, and enough tokens."

---

## sources

- https://ampcode.com/manual
- https://ampcode.com/how-we-build
- https://ampcode.com/fif
- https://ampcode.com/agents-for-the-agent
- https://ampcode.com/200k-tokens-is-plenty
- https://ampcode.com/how-to-build-an-agent
- https://ampcode.com/news/handoff
- https://ampcode.com/news/thread-map
- https://ampcode.com/news/agent-skills
- https://ampcode.com/news/oracle
- https://ampcode.com/news/librarian
- https://ampcode.com/news/rush-mode
- https://ampcode.com/news/amp-free
- https://ampcode.com/news/toolboxes
- https://ampcode.com/news/amp-x
- https://ampcode.com/news/read-threads
- https://ampcode.com/news/find-threads
- https://ampcode.com/news/look-at
- https://ampcode.com/news/command-palette
- https://ampcode.com/news/custom-slash-commands
- https://ampcode.com/news/gemini-3
- https://ampcode.com/news/opus-4.5
- https://ampcode.com/news/model-evaluation
- https://ampcode.com/news/no-more-byok
- https://ampcode.com/news/towards-a-new-cli
- https://ampcode.com/news/look-ma-no-flicker
- https://ampcode.com/news/AGENT.md
- https://ampcode.com/news/AGENTS.md
- https://ampcode.com/guides/context-management
- https://ampcode.com/models
- https://ampcode.com/pricing
