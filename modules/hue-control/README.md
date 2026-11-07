# hue permission continuity

macos remembers privacy approval against a code-signing requirement. the old
ad-hoc signature identified only one build's code hash; a fixed bundle id or nix
profile symlink could not make that identity survive rebuilt resources or node.

## host-owned identity

nix builds the payload and supplies signing tools. activation creates one local
rsa code-signing identity under `/var/db/hue-control-signing/identity`, signs a
private staging copy, verifies it with apple's `codesign`, and installs the real
`/Applications/Hue Control.app`. the agent uses that stable path. the requirement
pins both `dev.bdsqqq.hue-control` and the exact certificate, not merely a forgeable
app name. nested native code is signed as well.

signing uses `rcodesign` with a root-only local key file, not an interactive user
keychain. this permits background upgrades without weakening keychain locking or
adding a certificate to system trust. the key is unencrypted on disk, protected
by root-only directory/file permissions, like a host credential. it never enters
the nix store, repository, synced vault, command arguments, or event payloads.
back up the entire identity directory through a trusted encrypted host backup.
missing or changed identity material fails closed; it is NEVER silently renewed.

moving from the old ad-hoc identity may require ONE new bluetooth approval on the
mini. this is not a tcc reset, a blanket node permission, developer id, or
notarization. subsequent artifacts must satisfy the same certificate-bound
requirement. neither deployment nor troubleshooting edits privacy databases,
grants system trust, or toggles bluetooth.

## deployment versus bluetooth readiness

signing and verification happen before the current app is replaced. an
unauthenticated destination or edited installed app is preserved, not overwritten.
one authenticated previous generation is kept for recovery from an interrupted
rename. user enrollment/state remains outside the app and is not replaced.

unchanged launchd paths do not imply new code is running: the post-activation
step checks the named agent, listener ownership and a deployment id embedded in
the signed javascript. when necessary it sends that owned agent sigterm and
waits for the new process; it never kills an arbitrary listener. the non-ble cli
runs ordinary node and does not impersonate the permission-bearing app. only the
host-signed installation is registered for the user's desktop session.

`/health` acknowledges the running build and node version, NOT bluetooth access.
`/ready` remains false until the real enrolled light is available. without an
aqua session, activation defers agent handling until login. one-time approval
must be completed in the user's session; after approving, `hue reconnect` can
retry the existing enrollment without changing the light's power or pairing.

## verification

```sh
pnpm --dir modules/hue-control exec tsc --noEmit
nix build --no-link --no-write-lock-file .#checks.aarch64-darwin.hue-control
# or run the native fixture directly:
HUE_SIGNER=/nix/store/...-rcodesign/bin/rcodesign \
HUE_OPENSSL=/nix/store/...-openssl/bin/openssl \
HUE_APP_PAYLOAD='/nix/store/...-hue-control/Applications/Hue Control.app' \
node --experimental-strip-types --test modules/hue-control/host-install.test.ts
```

native fixtures change executable and resource bytes, cross-check both actual
designated requirements, reject an ad-hoc/wrong-key artifact, preserve relative
package links, and prove failed signing leaves the current generation intact.
the darwin nix check also swaps real node 24/26 payloads under the same fixture
identity. these tests do not request bluetooth permissions. the live acceptance test still
requires a successful light read before and after a real changed-build upgrade,
with no second consent prompt; compatible signatures alone do not prove that.

rationale: [apple tn3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)
and [tn2206](https://developer.apple.com/library/archive/technotes/tn2206/_index.html).
