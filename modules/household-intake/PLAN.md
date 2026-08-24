# household intake plan

## provenance

- amp thread: <https://ampcode.com/threads/T-01a01fa6-58fe-75e9-a87a-ce443c73bab7>
- repository: `bdsqqq/dots`
- recorded: 2026-08-24
- triggering user message, verbatim: “sounds good, persist this plan artifact, with provenance to your session and message, and lets start working on this.”
- architecture review request, verbatim: “alright, now ask oracle to review this updated understanding of the project”
- review provenance: Oracle reviewed the corrected architecture in this Amp thread after the architecture review request. Its accepted recommendations are incorporated below; corrections made after review remain explicit.

this artifact records decisions from the conversation, not merely the implementation at one commit. update it when a product invariant changes; ordinary implementation detail belongs beside the code that owns it.

## outcome

`ssd-01` is the household storage box. this project builds a trusted intake path for Igor's ownership root:

```text
/Volumes/ssd-01/igor
```

someone mounts an authenticated `Household Drop` folder in Finder, drops arbitrary files or directory batches, and may leave. accepted files disappear only after the system has preserved their submitted bytes, placed a canonical copy, recorded provenance, and proved that exact copy and its receipt can be read from an encrypted off-site snapshot.

`/Volumes/ssd-01/fenfe` is a separate human ownership boundary. intake must never enumerate, index, route into, or expose it. the pre-existing household backup plan may continue to protect both ownership roots; that broader backup policy is not owned by intake.

## commonplace is philosophy, not storage

`~/commonplace` is neither transport nor destination. its README supplies these design constraints:

- retrieval uses search and filtering rather than folder navigation;
- kept storage is mostly flat;
- names carry trustworthy dates, descriptions, and sparse searchable tags;
- folders survive only when relative structure, an external tool, or joint processing gives the group meaning.

intake must not recreate physical MIME shelves such as `photos/`, `videos/`, `documents/`, or `books/`. a `book` tag creates a virtual library; a books directory does not.

## ownership model

there is one canonical local copy after intake cleanup:

- `01_files` owns current user-visible bytes;
- append-only receipts own provenance, placement, version, and backup-proof history;
- SQLite is a rebuildable operational index and job queue;
- `00_inbox` is temporary transport and retains the submitted copy until exact proof;
- `02_temp` is disposable user work and is never authoritative;
- no permanent hidden content-addressed copy exists on the same exFAT volume.

a permanent second copy on the same SSD consumes capacity without protecting against device loss or filesystem corruption. temporary duplication during intake is intentional: source retention is the rollback boundary until Hetzner proves the canonical copy.

the one-copy model has a deliberate consequence. intake and normalization never overwrite submitted bytes, but a later user edit replaces the only local current version. that edit becomes a new hash/version event; the prior proven version remains recoverable from keep-all Restic history. if permanent local originals become a requirement, the product must explicitly add independent storage or accept a second immutable local copy.

## physical layout

```text
/Volumes/ssd-01/igor/
├── 00_inbox/                    # only SMB-exposed path
├── 01_files/                    # canonical, mostly flat
├── 02_temp/                     # disposable user work
└── .storage-system/
    ├── manifests/               # append-only receipts
    ├── catalog.sqlite           # rebuildable index and jobs
    ├── work/                    # crash-recoverable partial copies
    └── cleanup/                 # atomically claimed inbox entries
```

ordinary files use:

```text
DATE descriptive searchable name -- optional sparse tags.ext
```

- preserve submitted bytes and extension;
- use a content date only with recorded evidence; otherwise use intake date and record `date_source=intake`;
- never imply that filesystem mtime is a capture or document date;
- add only proven tags;
- transport provenance such as `via=smb` belongs in receipts, not an authorship-oriented `source__…` tag;
- detect collisions using normalized Unicode and case; never overwrite;
- do not mutate submitted documents to insert metadata.

a submitted directory is one of:

- a batch whose children become independent canonical files;
- a bundle whose relative structure is meaningful;
- a tool-owned tree whose external contract requires exact paths;
- an unresolved directory that remains visible in `00_inbox`.

the default is not to flatten an ambiguous directory automatically.

## components

one app-colocated `household-intake` module owns the product boundary:

```text
modules/household-intake/
├── PLAN.md
├── default.nix
├── household-intake-server.mjs
├── catalog.mjs
├── naming.mjs
├── backup-proof.mjs
└── service.nix
```

the intended responsibilities are:

- native macOS `smbd`: network filesystem transport only;
- intake daemon: sole durable writer, reconciliation, naming, placement, proof, and cleanup;
- append-only manifests: disaster-recovery authority for provenance;
- SQLite: rebuildable query/index/job state;
- Backrest: whole-root encrypted snapshots and exact snapshot lifecycle;
- gallery/files UI: read-only searchable views over intake APIs and canonical files.

do not implement SMB in Node. the app module reconciles a native SMB share as a transport dependency. if native SMB fails its security acceptance tests, replace only that boundary with Samba.

## SMB acceptance gate

the share is not production-ready merely because Finder can mount it. native SMB must prove all of the following on `mmn-m4`:

- the exact SSD UUID is mounted before any path or share is created;
- the share path is exactly `/Volumes/ssd-01/igor/00_inbox`;
- guest and anonymous authentication fail;
- a dedicated non-admin, sharing-only account can write;
- SMB3 encryption is negotiated;
- `01_files`, `.storage-system`, sibling shares, and `fenfe` are inaccessible;
- absent or wrong-volume state removes or disables the share and never creates a ghost `/Volumes/ssd-01` tree on the system disk;
- LAN access is denied if tailnet-only exposure is required;
- exFAT permissions, open-file behavior, rename behavior, and remount identity match the cleanup assumptions.

native `smbd` has no established per-share interface-binding control in the inspected management interface. if dedicated credentials, guest denial, tailnet restriction, or fail-closed mount behavior cannot be proven, use app-owned Samba with explicit users, `map to guest = never`, and interface controls.

the currently configured macOS Public share has guest access enabled. it is unrelated existing state and is not evidence that the intake share meets this gate.

## durable state machine

```text
waiting
  → settling
  → capturing
  → committed
  → awaiting_backup
  → verifying
  → proven
  → cleanup_claimed
  → complete
```

alternate transitions:

- source changes during settling or capture → `settling`;
- unsupported or ambiguous input → visible `needs_review`;
- missing snapshot path, lock, network failure, or hash mismatch → `awaiting_backup`;
- claimed source changed → restore visibly under a collision-safe inbox name and requeue;
- contradictory filesystem evidence → block and require reconciliation; SQLite never overrides bytes.

### settle and commit

filesystem events request scans; periodic reconciliation is authoritative. for each regular file:

1. reject symlinks and special files;
2. require a stable size, high-resolution mtime where available, file identity, and batch signature over a quiet window;
3. open without following symlinks and hash from the descriptor;
4. copy to a unique `.storage-system/work/<item-id>.partial`;
5. compare source descriptor state before and after, then ensure the pathname still names that file;
6. sync and independently hash the partial copy;
7. reserve a collision-free canonical name without overwrite;
8. rename the partial copy into `01_files`;
9. write and reread immutable intake and placement receipts;
10. for an exact duplicate, rehash the existing canonical file and add provenance without creating another canonical copy.

a quiet window is not proof that an SMB producer has finished. later source revalidation and refusal to delete on mismatch provide safety.

### exact backup proof

the static Backrest canary proves repository-level restoration, not inclusion of a new intake item.

after `CONDITION_SNAPSHOT_SUCCESS`:

1. the Backrest hook submits the full exact snapshot ID to a loopback intake endpoint;
2. intake durably records the candidate before acknowledging it;
3. intake runs `restic dump SNAPSHOT_ID EXACT_IGOR_CANONICAL_PATH` and hashes the stream;
4. intake runs `restic dump SNAPSHOT_ID EXACT_MANIFEST_PATH` and hashes that stream;
5. both hashes must equal their recorded local values;
6. intake appends an immutable proof receipt containing repository identity, full snapshot ID, exact paths, hashes, and verification time.

intake never lists or inspects unrelated snapshot paths. empty snapshot IDs from `skipIfUnchanged` are ignored. candidate IDs are idempotent and may arrive duplicated or out of order.

### cleanup

`stat → unlink` has a pathname replacement race. cleanup instead:

1. verifies the current inbox entry against its recorded identity;
2. atomically renames it to `.storage-system/cleanup/<item-id>.claimed` on the same volume;
3. rehashes the claimed bytes;
4. rehashes the current canonical file;
5. unlinks only when exact proof exists and submitted, claimed, and canonical hashes agree;
6. otherwise restores the claimed item visibly under a collision-safe inbox name and requeues it.

directory batches retain their complete submitted tree until every child is handled and proven, then verify a recursive manifest before cleanup. users should not observe partially disappearing batches.

## restart and failure contract

startup reconciliation handles every crash boundary:

- orphan partial copy: verify and resume or discard while source remains;
- destination exists without a database transition: match receipt and hash, then complete commit;
- claimed item with proof: reverify and finish;
- claimed item without proof: restore visibly;
- source absent after a proven unlink with stale SQLite: reconstruct completion from receipts and filesystem evidence.

before automatic cleanup is enabled, inject at least:

- uploads paused longer than the settle window;
- mutation during hash, copy, proof, and cleanup;
- same-name, case-equivalent, and Unicode-equivalent collisions;
- daemon termination after every filesystem/SQLite transition;
- SSD unmount during every state;
- wrong media mounted at `/Volumes/ssd-01`;
- lost, duplicated, stale, and out-of-order snapshot hooks;
- successful canary with canonical or manifest absent from the snapshot;
- Restic lock, network failure, missing path, and digest mismatch;
- directory mutation after one child is proven;
- forced-interruption tests for SQLite journal mode and exFAT rename/file-identity assumptions.

## migration

the current roots are migration inputs, not permanent taxonomy:

- `dump from panny` (~145 GB);
- `iphone-iph16-originals` (~52 GB);
- `photos-library-2` (~107 GB), currently serving gallery and intelligence.

order:

1. inventory every path, sidecar, and hidden metadata file; record a pre-migration snapshot and representative restore proof;
2. process `dump from panny` in bounded same-volume rename chunks;
3. process `iphone-iph16-originals` through the same intake path;
4. while `photos-library-2` stays live, import its database and sidecars as provenance and run the new gallery/catalog beside the old view;
5. validate counts, dates, locations, representative media, and unmatched-item reports;
6. cut gallery/intelligence over to intake-owned APIs;
7. process `photos-library-2` last in bounded chunks;
8. remove old roots only when each inventory entry is represented, deliberately retained as a bundle/tool artifact, or explicitly unresolved, with exact proof for every handled item.

lineage claims remain narrow:

- equal SHA-256 bytes are verified duplicates;
- explicit osxphotos original/edit/export linkage is a sourced representation relationship;
- matching names, dates, or UUIDs without explicit linkage are only `possible_related`;
- different HEIC, JPEG, edited, and exported bytes remain distinct.

## milestones

### 1. native SMB and exFAT acceptance spike

test share security, network exposure, wrong/missing-volume behavior, Finder upload semantics, and exFAT crash assumptions. do not build intake around native SMB until it passes. use Samba if it fails.

initial observation on 2026-08-24:

- `sharing -l -f json` reports only the pre-existing Public share, with guest access enabled, encryption not required, and no relationship to intake;
- `/System/Library/LaunchDaemons/com.apple.smbd.plist` exists but is disabled and is not loaded in the system launchd domain;
- TCP 445 refuses connections over both `mmn-m4`'s Tailscale address and LAN address;
- unauthenticated `smbutil view` cannot connect.

there is therefore no live SMB server to inherit accidentally. the spike must manage both the share record and the Apple daemon lifecycle. the existing Public share record must not be mistaken for a running or secure service.

### 2. vertical safety slice

- one Finder producer and `mmn-m4`;
- arbitrary regular files;
- flat canonical placement with conservative names;
- hashes and immutable receipts;
- exact duplicate reuse;
- exact snapshot proof;
- owner-only status endpoint/CLI;
- ambiguous directories and unsupported entries remain visible;
- cleanup exists behind a feature flag that defaults off.

enable cleanup only after a real Finder → SSD → Hetzner → restored canonical hash → restored manifest hash smoke test and the failure matrix pass.

### 3. naming, bundles, and searchable views

add deterministic metadata adapters and naming evidence. avoid category folders. gallery and file browser consume the shared intake catalog.

### 4. bounded legacy migration

process the existing roots in the order above. gallery cutover and legacy deletion are separate reviewed milestones.

## explicit non-goals for the first slice

- Syncthing intake;
- any storage or routing through `commonplace`;
- MIME-category folder trees;
- AI naming or routing;
- semantic search, OCR, embeddings, event enrichment, or training;
- format transcoding or automatic representation inference;
- broad family account/device rollout;
- automatic legacy-tree deletion;
- retention or pruning policy changes.
