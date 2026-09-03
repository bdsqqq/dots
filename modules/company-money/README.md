# company-money

`company-money` is a local, read-only evidence ledger for company transactions. it normalizes bounded Nubank statement CSV and Wise notification envelopes, preserves graded provenance, and reports completed amounts by native currency.

the package does not access Gmail or financial providers. mailbox collection remains in the existing read-only Google Workspace skill. private configuration and durable state live under `/Users/bdsqqq/commonplace/01_files/money/company-ledger` with `0700` directories and `0600` files.

## commands

```text
company-money ingest --adapter nubank-statement --input <private-statement>
company-money ingest --adapter wise-gmail --input <private-envelope>
company-money report --from <yyyy-mm-dd> --through <yyyy-mm-dd> --json
company-money report --from <yyyy-mm-dd> --through <yyyy-mm-dd> --json --output <name.json>
```

`--help` does not load configuration or create runtime state. ingest prints sanitized counts. reporting is the only command that prints aggregate amounts. optional report files are atomically replaced under the private `exports/` directory; path-like output names are rejected.

v1 treats the observed four-column Nu Empresas export as booked BRL movements because that provider format omits currency and status. the amount sign supplies direction; `Descrição` remains a reference rather than being guessed into a counterparty identity.

the public package export contains only portable schemas, contracts, and plain operations. Node-only persistence, translators, private configuration, and cli composition are available from `company-money/node`.
