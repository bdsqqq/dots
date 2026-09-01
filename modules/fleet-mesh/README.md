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
