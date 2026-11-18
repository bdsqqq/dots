# kanata

Nix installs the commands and declares the services. the commands run this live
checkout; ordinary controller edits need no rebuild. changing Nix wiring still
needs activation. installation, service startup, and macOS approval are separate.

## installation and approval

activation and `kanata-install` call the same [installation operation](install.ts).
it installs the pinned, vendor-signed VirtualHID package when its receipt/files
are missing or a compatible v6 update is needed, then stages kanata and its
libraries at stable paths. it refuses to replace an unknown/incompatible driver
version. it does not activate the system extension or grant macOS permissions.

[kanata 1.12's setup instructions](https://github.com/jtroo/kanata/blob/v1.12.0/docs/setup-macos.md)
require VirtualHID 6.2.0's IPC. the latest driver is not a safe default. the pinned
package contains the daemon and manager but no launchd plist; this module retains
one daemon owner rather than installing a second service.

```sh
sudo -v
kanata-install                 # explicit repair; never implicit in start
# then follow the approval instructions from:
toggle-kanata doctor
```

if the driver is inactive, use the vendor manager:

```sh
sudo /Applications/.Karabiner-VirtualHIDDevice-Manager.app/Contents/MacOS/Karabiner-VirtualHIDDevice-Manager activate
```

approve Driver Extensions in System Settings; macOS may require a restart.
approve `/usr/local/bin/kanata` under Privacy & Security → Input Monitoring
(and Accessibility if requested). re-add that exact binary if an old approval
is stale. the stable path avoids tying approval to a changing Nix store path;
updates can still invalidate approval when the signature changes.

## service control

```sh
toggle-kanata status -v
toggle-kanata start
toggle-kanata stop
toggle-kanata restart
toggle-kanata restart -n       # inspect the plan without writes
kanata-test                   # requires the managed job to be unloaded
```

`toggle` (the default) stops a loaded job, even if it is crash-looping. use
`start` or `restart` to recover it. `stop` leaves the shared VirtualHID daemon
running. mutations require root or cached `sudo -v` authorization.

start reports success only after a managed kanata PID survives three seconds
and its log reports current-run VirtualHID readiness, within a 20-second startup
deadline. a one-line package patch makes kanata emit dated, offset-qualified
log timestamps. time-only legacy logs cannot prove readiness: install the updated
binary and restart the service first. this changes the signature, so macOS may
require renewed approval on a previously working host too.

the latest startup timestamp must match the process's start; only
records after that marker count. a backwards, bounded-memory scan retains the
latest backend and input-grab records even behind megabytes of heartbeats.
file modification time is not readiness evidence. backend recovery is unhealthy
even if the process remains alive. this is not
an end-to-end keyboard test. the system service executes the staged binary
directly, not a user-writable startup script. `doctor` returns typed findings to direct
callers and exits nonzero when its configuration, driver, or process checks are
unhealthy. log-based permission findings are historical evidence, not a TCC query.

`kanata-test` shares dependency checks and readiness observation, runs for 60
seconds after startup, and unloads its unique transient system job on completion,
failed startup, or repeated Ctrl-C/SIGTERM. each session has its own log. it refuses an already-loaded normal job and
never uses global process killing. cleanup only targets its unique label, even
if registration returned an ambiguous error. stop/cleanup query launchd without
requiring `ps` to work. the command elevates once for the whole session, so
cleanup does not depend on the sudo cache remaining valid for its duration.

all launchd calls, including read-only cleanup lookups, run through the native
signal guard. only `pgrep` exit 1 means no manual Linux process; execution errors
remain failures rather than being mistaken for a successful stop.

native installation has a 25-minute command limit, covering the package's two
600-second script limits plus payload work. installation and launchd registration
finish before cancellation cleanup reconciles them; Ctrl-C is not a safe way to
interrupt an installer transaction. other commands retain a 15-second limit.

## verification

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
```

on Darwin, tests inspect the real signed package and run relocation, signing,
version, and idempotence checks under a temporary prefix. native installation
commands and launchd mutations use fixtures; tests do not install a driver,
approve permissions, activate the host, or remap the live keyboard.
