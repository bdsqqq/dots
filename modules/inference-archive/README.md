# retired wire archive

the full-body inference recorder, publisher, collector, ClickHouse index, and
scheduled archive backups are retired. a 657 KB native Pi session produced 55 MB
of repeated client/upstream wire journals; transport capture was the wrong
default for conversation retention.

existing data is retained, not migrated or deleted:

- producer and collector state: `~/.local/share/inference-archive/`;
- derived database state: `~/.local/share/inference-archive-database/`;
- existing encrypted snapshots in the initialized StorageBox repository.

do not treat retirement as permission to prune these files or snapshots. the
[broker](../cli-proxy-api/README.md) and opt-in one-hop peering remain independent.
Pi's native session JSONL remains its conversation record; request-metadata
entries in that file are future work, not a replacement implemented here.
