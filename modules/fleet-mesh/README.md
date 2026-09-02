# fleet mesh

executable reference model for a delay-tolerant fleet message plane. virtual
nodes exchange immutable records whenever a transport gives them contact; the
core does not know whether that contact came from ble, a lan, tailnet, serial,
or a simulator.

the current slice proves:

- ed25519-authorized commands and node-signed receipts;
- x25519 key agreement with aes-256-gcm payload encryption;
- target-addressed `set` operations with monotonic resource revisions;
- stale and expired command rejection;
- scheduled activation;
- replay-safe outcomes that survive node snapshot/restore;
- store-and-forward reconciliation after a partition.

run it:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm run typecheck
pnpm run demo
pnpm run lab
```

`fleet-mesh.ts` is the protocol reference, not the eventual esp32 runtime. its
tests should become shared conformance vectors for a bounded esp-idf
implementation. `daemon.ts` supplies atomic snapshots and real HTTP contacts;
`lab.ts` runs `mbp-m2`, `lgo-z2e`, and `virtual-esp32` as separate HTTP
endpoints, then carries an encrypted wi-fi profile and its receipt through the
relay. the next slice can run this adapter on the two physical hosts; ble
discovery and the embedded port can implement the same record exchange
contract.

## package boundaries

- `fleet-public.ts` exports browser-safe ArkType schemas, plain use cases, and
  handler-free oRPC contracts.
- `fleet-node.ts` exports crypto, persistence, `LocalFleetRuntime`, and the
  implemented local client.
- `fleet-cli.ts` projects public oRPC metadata and invokes that same client. it
  supports only genuine no-input and scalar-positional operations.

protocol v1 values remain unchanged. schema identity and version live in
`fleetSchemaCatalog` when the existing wire value does not already carry them.
all untrusted record boundaries call `validateV1MeshRecord` without replacing
the validated object before cryptographic checks.

the original verifier uses Node's permissive base64 decoder for signature text.
v1 therefore continues to accept unpadded variants when the record id covers
that exact text. canonical signature encoding is reserved for protocol v2.

ArkType runtime validation is authoritative. recursive `JsonValueV1` requires a
pure `.narrow()` to reject unsafe integers nested inside arrays and non-plain
objects. ArkType 2.2.3 cannot faithfully convert that predicate or the
containing snapshot schema to JSON Schema, so those two conversions are
deliberately unavailable until a named consumer exists or ArkType gains a
faithful conversion. there is no parallel hand-authored JSON Schema catalog.

## local CLI

the packaged `fleet` executable reads an explicit runtime configuration from
`FLEET_CONFIG`. relative state paths resolve beside that configuration file.
the file belongs inside the existing secrets boundary because node identities
contain private keys.

```json
{
  "version": 1,
  "fleet": "home",
  "authority": {
    "id": "fleet-admin",
    "publicKey": "<PEM>"
  },
  "nodes": [
    {
      "identity": {
        "id": "virtual-esp32",
        "signingPublicKey": "<PEM>",
        "encryptionPublicKey": "<PEM>",
        "signingPrivateKey": "<PEM>",
        "encryptionPrivateKey": "<PEM>"
      },
      "publicIdentity": {
        "id": "virtual-esp32",
        "signingPublicKey": "<same PEM>",
        "encryptionPublicKey": "<same PEM>"
      },
      "statePath": "virtual-esp32.json"
    }
  ]
}
```

```bash
FLEET_CONFIG=/path/to/fleet.json fleet node list --json
FLEET_CONFIG=/path/to/fleet.json fleet node describe virtual-esp32
FLEET_CONFIG=/path/to/fleet.json fleet node exists virtual-esp32
```

`--json` is output-only and emits one stable JSON document. `node.list` has no
input flag.

## third-operation extension cost

`node.exists` is the extension-cost probe. its hand-authored production touch
points are:

1. `fleet-schema.ts` — add `FleetNodePresenceV1` and its catalog entry;
2. `fleet-contract.ts` — declare the operation and scalar input metadata;
3. `fleet-operations.ts` — add the plain use case;
4. `fleet-router.ts` — bind the use case to the contract implementation.

tests added assertions in `fleet-schema.test.ts`, `fleet-operations.test.ts`,
and `fleet-cli.test.ts`. `fleet-cli.ts` required no operation-specific change:
public oRPC traversal discovered and invoked the new procedure. this is a
static touch-point measurement because the initial vertical slice remains one
uncommitted work unit, not a commit-to-commit measurement.
