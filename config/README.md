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

To retire an alias:

1. repoint its link in the owning module and publish that change;
2. wait until every host has activated it and its link resolves to the new
   path, and its checkout has that path;
3. wait until no rollback candidate generation on any host still links into
   `config/`;
4. then delete the alias here.
