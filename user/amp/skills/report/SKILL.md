---
name: report
description: message coordinator as a spawned agent
---
# report

you were spawned by a coordinator. report back to them.

## send a message

```bash
tmux send-keys -t $COORDINATOR_PANE 'AGENT $NAME: <message>' C-m
```

`$COORDINATOR_PANE` and `$NAME` were provided in your spawn instructions.

## when to report

- task complete
- blocked and need guidance
- found something the coordinator should know
- need clarification on scope

don't report every step — only meaningful state changes.

## etiquette

- message coordinator, not peer agents. let coordinator relay between agents if needed.
- be concise. coordinator is managing multiple agents.
- prefix with `AGENT $NAME:` so coordinator knows who's talking.
