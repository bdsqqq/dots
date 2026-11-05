# sagemcom fast3896_claro sdk

`@bdsqqq/sagemcom-fast3896-claro` is a node-only typescript sdk specifically for the **Sagemcom FAST3896_CLARO / FAST3896-15**, not a universal router abstraction. convenient Wi-Fi/identity operations sit on the same client as typed model access, remote commands, and raw batches. no browser, cookies, background polling, or nix activation is required.

identified firmware: `FAST3896-15-3x3_CLARO_sw18.83.15.17h-185`, hardware `4.0`, GUI API `2.92`. the authoritative snapshot and its discovery outcomes are in [inventory/firmware.json](inventory/firmware.json); [API.md](API.md) is the generated reference for every cataloged node and command.

for the shop’s password rotation procedure, use [RUNBOOK.md](RUNBOOK.md). its command is read-only unless `--apply` is supplied.

## use it

```sh
pnpm install --frozen-lockfile
pnpm run build
```

```ts
import { readFileSync } from "node:fs";
import { SagemcomFast3896Claro } from "./dist/index.js";

const router = new SagemcomFast3896Claro({
  // defaults to http://192.168.0.1; an origin, not a GUI page URL
  auth: {
    mode: "credentials",
    username: process.env.FAST3896_CLARO_USERNAME ?? "",
    password: readFileSync(process.env.FAST3896_CLARO_PASSWORD_FILE!, "utf8").replace(/\r?\n$/, ""),
  },
});

try {
  const identity = await router.assertCompatible(); // exact model, hardware, firmware, and GUI API match
  const guest = await router.wifi.guest.get(); // SSID + enabled; not its password
  const version = await router.model.get("Device/DeviceInfo/SoftwareVersion"); // string
  const ssid = await router.model.get("Device/WiFi/SSIDs/SSID[Alias='WL_GUEST']/SSID");
} finally {
  await router.logout();
}
```

use the package's root export when installing this directory as a local dependency. source entrypoints are in [src/index.ts](src/index.ts). node 24+ can also run the `.ts` source directly. the browser boundary is deliberate: do not put router credentials, imported sessions, or this node client in frontend bundles.

## choose how much control to own

- `SagemcomFast3896Claro`: identity, configurable Wi-Fi networks, guest password rotation, file recipes, plus everything below.
- `router.model`: generated path/value types and command input/output types. configuration writes reject status-only fields. list elements require an explicit selector.
- `router.node(xpath)`: an unrestricted path with get/read/readAll/default/set/add/delete/call operations.
- `router.execute(actions)`: one native batch with full reply/callback/extension data. at most 90 actions; no automatic splitting or atomicity claim.
- `SagemcomXmoClient`: the underlying Sagemcom XMO transport/session escape hatch, without the model-specific convenience layer.

`router.supportedDevice` (also exported as `supportedDevice`) is generated from the checked inventory, including exact hardware and firmware versions. `assertCompatible()` explicitly reads and checks the connected device; a mismatch throws `UnsupportedDeviceError`. pass an already-fetched identity to avoid another read, or use the pure `assertCompatibleDevice(identity)` helper. other methods do not silently fetch identity or promise automatic compatibility enforcement. generation rejects catalogs for another model/product class.

```ts
const nodes = await router.model.getAll("Device/WiFi/SSIDs/SSID[*]/Enable");
const details = await router.read("Device/WiFi", {
  "capability-flags": { interface: true, attributes: true, children: true },
});
const unknownToThisSnapshot = await router.node("Device/aFutureExtension").get();
```

singular `get`/`read` calls reject multiple callbacks instead of silently taking the first. `readAll`, `model.getAll`, and raw replies retain wildcard results. object values retain the native wrapper, e.g. `{ DeviceInfo: ... }`; only explicit adapters unwrap them.

supplied data needs no client, provider, or extra fetch:

```ts
import { identityFromDeviceInfo, wifiNetworkFromValues } from "./dist/index.js";
const identity = identityFromDeviceInfo(savedDeviceInfo);
const guest = wifiNetworkFromValues(savedSsid, savedEnabled);
```

## mutations are opt-in

construct a separate client with `allowMutations: true` to write values, add/delete elements, run remote commands, or upload files. unknown commands are conservatively gated too, including commands whose names look read-only. login/logout and explicit notification operations still change session state in the default mode. this is a client-side guard, not router authorization.

```ts
const writer = new SagemcomFast3896Claro({ auth, allowMutations: true });
await writer.assertCompatible();
const result = await writer.wifi.guest.rotatePassword({ expectedSsid: "Bike-IoT", password: newPassword });
```

handle `result.status`: only `verified` confirms API readback. `ssid-mismatch` means no write; `accepted` means `verify:false` skipped readback; `verification-mismatch` means the returned key differed. see the [runbook](RUNBOOK.md) for cleanup, failure handling, and phone verification.

rotation writes **only** `GUEST1/Security/KeyPassphrase`; it does not rewrite the SSID, main Wi-Fi, administrator password, band steering, or wizard state. aliases are configurable through `writer.wifi.network({ ssidAlias, accessPointAlias })`. the expected-SSID check is best-effort, not compare-and-set. verify the target firmware/aliases before writing. API readback does not prove a phone can associate or access the internet.

remote commands use the catalog's signatures, not a parallel handwritten registry:

```ts
const result = await writer.model.command("Device#ping", {
  Host: "example.com", Count: 3, Protocol: "IPV4",
});
const received = result.outputs[0]?.PacketsReceived;
// full callbacks/extension fields remain available in result.reply

await writer.call("Device", "aFrontendOnlyCommand", { SomeParameter: "value" });
```

command metadata does not declare requiredness, so generated inputs/outputs are optional. runtime validation checks JSON, known parameter names, primitive types, enums, lengths, and numeric bounds. firmware regex restrictions remain router-owned; executing arbitrary supplied regexes could hang a caller. unknown/custom XMO types remain `Json`, not guessed TypeScript structures. integer values outside JavaScript's safe range are unsupported by typed access; raw JSON parsing does not restore lost precision.

## errors, cancellation, and partial outcomes

- `XmoError`: request, action, or callback failure, including permission denial, delayed application, and reboot-required statuses. `code` is machine-readable; `errorCodes` exports the shipped error vocabulary. `reply` retains partial successes and is non-enumerable because it can contain secrets.
- `TransportError`: HTTP/network/body failure. mutations have `outcome: "unknown"`; never blindly retry them.
- `ProtocolError`: malformed, incomplete, miscorrelated, or unexpectedly plural replies. a failed write may still have applied, even when no usable reply exists.
- local `TypeError`: invalid input or schema mismatch. mutation opt-in failures reject before authentication/network traffic.

a batch can partially apply before a sibling fails. there is no rollback. no operation automatically retries, reboots, resets, reconnects Wi-Fi, or replays a failed mutation. an expired session is invalidated; credentials clients can log in on the next explicit call, but the failed call is not retried. imported-session clients require replacement credentials/session after expiry.

all request methods accept `{ signal, timeoutMs, priority }` where applicable. defaults are a 30-second timeout and normal priority. concurrent requests reserve unique IDs and share in-flight login. later waiters have independent abort/timeout bounds and do not cancel the shared authentication transport. the caller that starts login owns that transport; cancelling it can fail other waiters. coordinate logout with your own in-flight work. simultaneous clients restored from the same session must coordinate their request counters.

## notifications and files

`router.events` exposes all native notification types: value-change, periodic, add-child, delete-child, delete-element, and global. subscriptions are explicit; no work starts on import or construction.

```ts
const id = await router.events.subscribe("Device/DeviceInfo/UpTime", {
  type: "periodic", timer: 5, currentValue: true,
});
try {
  const events = await router.events.poll({ signal, timeoutMs: 10_000 });
} finally {
  await router.events.unsubscribe(id);
}
```

`events.reset()` explicitly clears this session's notifications. native get-events control/error statuses remain `XmoError` codes for the caller to handle; there is no hidden polling/retry loop. raw `call` also accepts an event ID for asynchronous remote commands.

`files.getDownloadUri`, `files.restore`, `files.firmwareUpgrade`, and `files.docsisFirmwareUpgrade` implement the retained frontend recipes. they share `call`/`upload`; no DOM forms or page navigation are used. multipart `upload(actions, files)` remains available for additional command shapes. `download(uri)` only accepts the router's origin and rejects redirects. file recipes and destructive commands are fixture-tested, **not executed on the live router**. frontend presence is not proof that firmware authorizes them.

## what “exhaustive” covers

[API.md](API.md) and the generated types cover every node and command signature in the checked snapshot. the native transport covers the full operation families found in the retained frontend: sessions, reads/defaults, writes, child creation/deletion, subscriptions/events, remote calls, multipart upload, and URI-based download. [inventory/sources.json](inventory/sources.json) records asset digests, literal XPath coordinates, frontend command names, endpoints, and error codes; raw captures and credentials are not included.

`discoverCapabilities(client)` performs breadth-first **read-only** discovery from `Device` and optional seed paths. containers are expanded with wildcards to discover existing instance types without creating instances. it strips values, defaults, descriptions, concrete selectors, and credentials before retaining metadata. supplied literal frontend/HAR paths seed dynamic extensions omitted from parent listings. unsupported paths, empty-list wildcards, missing metadata, and traversal limits remain inspectable in `catalog.coverage`.

this is **not** proof of every hidden privilege, unvisited lazy bundle, empty-list element schema, future firmware extension, or command's successful execution. some visible parent paths fail while more specific paths work. dynamic expressions are not resolved as invented paths. raw `read`, `execute`, and `call` preserve access beyond the generated profile. refresh the snapshot for another router role/firmware rather than asserting this profile matches it.

## maintain and verify

```sh
pnpm run check  # non-writing drift check → typecheck → tests → build
```

read-only live probe, after building:

```sh
FAST3896_CLARO_USERNAME=... FAST3896_CLARO_PASSWORD_FILE=/private/password-file pnpm run probe
```

refresh metadata explicitly (no configuration writes):

```sh
FAST3896_CLARO_USERNAME=... FAST3896_CLARO_PASSWORD_FILE=/private/password-file pnpm run capture
pnpm run generate
pnpm run check
```

an existing local HAR can supply source references and, when it includes a matching administrator password assignment, login credentials:

```sh
pnpm run capture --har /private/router.har
pnpm run generate
```

`node scripts/capture.ts --sources-only --har /private/router.har` extracts references without contacting the router. capture/SDK secrets stay in memory; passwords and session credentials are never auto-saved. keep the original HAR private: it may contain plaintext passwords and reusable sessions. explicitly exported sessions, native replies, download URIs, and errors' partial replies must also be treated as credentials. the router's HTTP connection is unencrypted; only use a trusted LAN.

unit/integration fixtures exercise protocol signing, transport, type inference, partial failures, mutation gates, notifications, files, discovery, and password rotation. isolated fixtures deliberately corrupt generated files/inputs and loosen types to verify checks fail. live verification is limited to fresh login/logout, identity, typed reads, defaults, wildcard reads, Wi-Fi status, and metadata discovery. no live mutation, reboot/reset, upload, or phone connectivity check is performed.
