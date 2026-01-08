---
source: "https://ampcode.com/200k-tokens-is-plenty"
---
[Opus 4.5](https://ampcode.com/news/opus-4.5) came out a few weeks ago and quickly became not only Amp's main model, but also universally respected as the best model for coding — while having a context window of roughly 200k tokens. In the winter of 2025, that's not a lot. A lot of people view this as a downside.

But here's the thing — 200k is enough for me, it's plenty. I love short threads. I do all my work with short threads. So does the rest of the team.

In fact, I took a look at a feature I just shipped for Amp, adding a `thread: send to support` command to the Amp CLI [command palette](https://ampcode.com/news/command-palette). Here's what it looks like as a cluster of interconnected threads:

![Feature: Add Thread Support Command](https://ampcode.com/200k-tokens-is-plenty/feature-for-blog-1.svg)

Feature: Add Thread Support Command

Look at all those tiny threads! Look at the token counts, and the number of user messages sent. The biggest thread is 151k output tokens and four user messages. The average thread is around 80k tokens. Now think of the time when we had a [1 million token context window](https://ampcode.com/news/1m-tokens). I wouldn't run a thread that long…

But hey, there are 13 threads in that feature. Probably more, as these are only the threads connected by [thread mentions](https://ampcode.com/guides/context-management#mentioning-files). Add up all those and you're close to one jam-packed 1 million token context window.

So why not pile those all into one mega-thread and be done with it? Why bother with the tedium and drudgery of spinning up thread after thread with those puny, embarrassingly small contexts?

## Short Threads Are Best

On the Amp team, we've known this for a while. The best threads are short, they do one thing, and they have just the right amount of context to do it. We've written about this in our guide on [context management](https://ampcode.com/guides/context-management):

**Agents get drunk if you feed them too many tokens.**

I don't know how to explain it better than this — they act drunk. They mess up, they fall over, they pick fights with you, and (if you feed them enough tokens) they'll vomit all over you. It's a mess.

Agents are models combined with a system prompt, tools, as well as the history of the conversation so far. The longer the conversation, the more the agent's context window gets filled up with stuff not quite related to what it should be doing right now.

In order to get the agent to perform at its best, you need to give it the context it needs to get the job done, and no more.

**Long threads are not just worse, they also cost more.**

Way more. Not only does every token get sent to the provider with every request, exponentially increasing the cost of new messages, but some providers like Anthropic also charge more for [long-context](https://platform.claude.com/docs/en/about-claude/pricing#long-context-pricing) requests for some models. Long threads are also more likely to have longer idle periods between user messages, and so are more likely to miss the cache window — a major contributor to expensive runaway threads.

So they give worse results, and you pay through the nose for them.

But there's something else.

**Breaking into short threads == breaking into small tasks.**

Big tasks are best broken down into small tasks. This was true before the agents came, and it's true now that they're here. Short threads make it easy (or even fun?) for you and me — lowly humans — to do that.

Just like small tasks are easier to work with, so are small threads. You can keep track of them easily, each has a well-defined goal, and life doesn't feel too different from the old agentless world of yesteryear — but faster, and with less typing.

If you think of threads as units of tasks, then it's intuitive to think of a feature or bugfix as a cluster of threads.

## Life in Threads

Here's another look at the feature I worked on last week, but with some added scribbles:

![Feature: Add Thread Support Command - annotated diagram](https://ampcode.com/200k-tokens-is_plenty/feature-for-blog-2.svg)

Feature: Add Thread Support Command

This is how I work, from bottom to top:

I start with a thread to build a basic implementation. If I think it's going to be complicated, I might start with a thread to investigate some area of the codebase and gather the required context.

From that base, I'll start new threads to tweak or refactor. Each change is a new thread — one change per thread. I use the [`read_thread` tool](https://ampcode.com/news/read-threads) to gather needed context from either the initial thread or from the previous refactor/tweak thread.

When I'm happy, it's time to review the code. Sometimes I use new threads to help read the new code, investigate if it matches existing patterns, and make sure nothing nefarious snuck in. Those are all new threads.

Or I might want to validate with one-off scripts, throw-away tests, running in a profiler, spamming logs, forcing error states… These are all new threads.

My preferred way to share context between threads is to reference threads by mentioning their ID or URL, but there are other ways. In Amp you can use a [handoff](https://ampcode.com/news/handoff) or [fork](https://ampcode.com/news/thread-forking) command to create new threads. You can leverage the git state by telling Amp to run `git diff` or to inspect previous commits. Some people use multiple `.md` files with specs and histories to store and transfer context between threads — I'm not one of those people.

I use the Amp CLI, so the actual key-typing process of creating new threads and referencing previous ones is something like:

- Choose `thread: new` in the command palette, hit `enter` to accept the hint to reference the previous thread.
- Or: create a new thread and use `@@` to mention and reference a thread.
- Then type the new task prompt and set it off.

Repeat for any new tasks, or if I prefer the context from the main thread, just `thread: switch to previous` and repeat.

That's it! Each thread is a discrete task, and together they form a feature.

I love working through a big problem this way — breaking it down into baby steps, letting this [superpowered alien orb made of sand](https://registerspill.thorstenball.com/p/theres-beauty-in-ai) rocket through each one. It's still me at the wheel, but it's fast, cheaper, and easier to reason about.

200k tokens? Plenty, if you make use of threads.
