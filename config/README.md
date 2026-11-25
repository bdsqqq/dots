# config

Stable paths for files that live checkouts link to, not a place to put
config. Hosts activate from the published flake while their synced checkout
may lag behind, so home-manager's out-of-store links point here: these paths
exist in every checkout, old or new. Each is a symlink to the file's owner;
edit it there.

| path | owner |
|---|---|
| `global-agents.md` | `modules/agents/global-agents.md` |
| `ignore-common`, `rgignore` | `modules/shell/` |

To retire an alias: repoint its link in the owning module, wait until every
host's checkout has the new path and no pre-move generation remains a
rollback candidate, then delete it here.
