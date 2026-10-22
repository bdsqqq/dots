# company-money

company-money ingests bounded Nubank statements and Wise notification envelopes
into a private local ledger. it preserves provenance and reports completed amounts
by native currency. the implementation includes a manually invoked CLI and a
separate read-only dashboard; neither writes to a financial provider.

## commands

```text
company-money ingest --adapter nubank-statement --input <private-statement>
company-money ingest --adapter wise-gmail --input <private-envelope>
company-money report --from <yyyy-mm-dd> --through <yyyy-mm-dd> --json
company-money report --from <yyyy-mm-dd> --through <yyyy-mm-dd> --json --output <name.json>
```

`--help` does not load configuration or create runtime state. ingestion prints
sanitized counts; reports print aggregate amounts. optional report files are
atomically replaced under the private `exports/` directory. path-like output
names are rejected.

mailbox collection belongs to the [company-money skill](../agents/skills/company-money/SKILL.md)
and its existing read-only Gmail workflow. this package receives bounded input;
it has no mailbox client, provider SDK, OAuth flow, or credentials loader. Wise
transient envelopes are removed only after a durable ingest or quarantine result;
Nubank source statements are retained.

## ledger contracts

- [money](money.ts) uses positive safe-integer minor units plus direction. currencies
  stay separate: no inferred FX conversion, tax calculation, or accounting export.
- [ingestion](ledger/ingest.ts) keeps evidence identity separate from transaction
  identity. replay is idempotent; compatible observations merge provenance.
  field-specific precedence allows primary statements to correct secondary
  notifications, but incompatible evidence aborts the batch rather than letting
  arrival order choose a winner.
- [transfer reconciliation](ledger/link-transfers.ts) links both transactions rather
  than deleting either side. only confirmed account relationships and mutually
  unambiguous matches qualify; ambiguity remains visible.
- [reporting](ledger/report.ts) distinguishes receipts, revenue, and outgoing money.
  incoming money is not automatically revenue; tentative classifications stay out
  of revenue totals, and failed or cancelled transactions are not totaled.
- [storage](ledger/jsonl-store.ts) validates canonical JSONL before use, rejects
  corrupt or future-version state, and commits through locking, revision checks,
  and atomic replacement. it fails closed rather than repairing financial data
  implicitly.

v1 treats the observed four-column Nu Empresas export as booked BRL movements
because that provider format omits currency and status. the amount sign supplies
direction; `Descrição` remains a reference rather than being guessed into a
counterparty identity. provider-specific translation stays in [evidence/](evidence/),
not in the ledger operations.

## private state and ownership

CLI configuration and durable state live under
`/Users/bdsqqq/commonplace/01_files/money/company-ledger`: `config.json`,
`ledger.jsonl`, `state/`, and optional `exports/`. directories are `0700`; private
files are `0600`. private values and source evidence do not belong in git, test
fixtures, logs, or build output. configuration and storage reject symlinks; the
ledger also refuses a root inside a Git worktree.

canonical entity identities are registered legal names. private display aliases
change presentation, not identity. confirmed owner-funding and internal-transfer
rules come from [private configuration](private-config.ts), not guesses based on
transaction direction or counterparty text.

`mbp-m2` is the intended ledger writer. local locking is not a distributed lock:
existing commonplace Syncthing replication does not make concurrent writes from
multiple machines safe. replicated files remain readable on the trusted receivers;
filesystem permissions are not application-level encryption.

## read-only dashboard

[portal/](portal/) projects the replicated ledger, private display aliases, and
mail-review metadata into a tally. its completed incoming/outgoing/net amounts
are a cash-movement view, not the CLI's classification-filtered revenue report;
internal transfers remain part of those movements.

[the server](portal/portal-server.mjs) accepts only GET and HEAD, serves
`/api/tally`, and has no ingestion endpoint. it defaults to loopback and sends
private, no-store cache headers. access control belongs to the deployment, not an
application login: [the declaration](portal/tailnet-app.nix) requests owner-only
Tailscale and Cloudflare Access routes. do not expose the listener directly.

[the m2 module](default.nix) installs the CLI without creating a ledger or scheduling
collection. [the apps-container configuration](../../hosts/htz-relay/apps-container.nix)
runs the dashboard against its replicated root at
`/srv/commonplace/01_files/money/company-ledger`, with a read-only filesystem view.
these are configuration contracts, not evidence that a live deployment is healthy.

## package boundaries and checks

[the public export](company-money-public.ts) contains portable schemas, contracts,
and operations. [the Node export](company-money-node.ts) composes persistence,
private configuration, translators, and the local client. ArkType schemas own
runtime validation; there is no parallel hand-written wire-schema catalog.

from this directory, use synthetic fixtures only:

```sh
pnpm run typecheck
pnpm test
node --test portal/portal-server.test.mjs
pnpm run build
```

private ingestion, mailbox access, and live dashboard checks require separate
explicit authorization. tests are not permission to read the real ledger.
