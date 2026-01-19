---
name: report
description: "message coordinator as a spawned agent. use when you were spawned by coordinate/spawn and need to report progress, completion, or blockers back to the coordinator."
---
# report

you were spawned by a coordinator. report back to them.

## send a message

```bash
tmux send-keys -t <coordinator-pane> 'AGENT <your-name>: <message>' C-m
```

`<coordinator-pane>` and `<your-name>` were provided in your spawn instructions.

## when to report

- task complete
- blocked and need guidance
- found something the coordinator should know
- need clarification on scope

don't report every step — only meaningful state changes.

## etiquette

- message coordinator, not peer agents. let coordinator relay between agents if needed.
- be concise. coordinator is managing multiple agents.
- prefix with `AGENT <your-name>:` so coordinator knows who's talking.
