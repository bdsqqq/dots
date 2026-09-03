---
name: company-money
description: "Ingests bounded Wise Gmail notifications and Nubank statements into the private local company ledger, then produces explicit native-currency reports. Use for manually invoked company-money ingestion or reporting."
---

# company money

orchestrate the installed `company-money` cli. implementation, credentials, and private values stay outside this skill.

## hard boundaries

- require an explicit inclusive date interval and a narrow Wise-only query before mailbox access. refuse unbounded or open-ended collection.
- load and use the existing `accessing-google-workspace` skill for Gmail. use read-only search, message, and attachment operations only.
- never request Gmail write scopes, mutate mail, implement OAuth, load credentials, or schedule a recurring run.
- never print message bodies, transaction values, account aliases, counterparties, references, configuration, source paths, or schema errors.
- never access or write a financial provider. the only mutation is the local canonical ledger.

## Wise ingestion

1. use `accessing-google-workspace` with the supplied bounded interval and narrow query.
2. materialize only supported Wise notifications in one exact `company-money.wise-gmail-envelope@1` JSON value. include opaque source references, received timestamps, subjects, minimum message bodies, and the privately configured opaque account alias. do not include headers, threads, labels, unrelated messages, attachments, credentials, or query results outside the interval.
3. create the transient envelope as a regular `0600` file under the private ledger's `state/` directory. do not place it in git or a general temporary directory.
4. run `company-money ingest --adapter wise-gmail --input <private-envelope>`.
5. the cli removes the envelope only after a durable ingest or quarantine result. if the command fails, leave it in place and report only that manual recovery is required.
6. report only the cli's sanitized inserted, duplicate, conflict, quarantine, and link counts.

## Nubank ingestion

accept only a user-selected, bounded, regular `0600` statement file. run:

```text
company-money ingest --adapter nubank-statement --input <private-statement>
```

the cli treats the statement as primary evidence and does not remove it. report only sanitized counts.

## reporting

run reports only when explicitly requested:

```text
company-money report --from <yyyy-mm-dd> --through <yyyy-mm-dd> --json
```

reports use inclusive booked dates and separate native currencies. add `--output <name.json>` only when a durable export is explicitly requested; the cli confines atomic exports to the private `exports/` directory. do not infer fx, tax, accounting treatment, or classifications not present in the private policy.
