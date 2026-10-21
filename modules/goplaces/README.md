# places auth provisioning

imports default to **package-only** (`my.goplaces.enable = false`). installation
and help do not establish authentication. `goplaces-auth ready QUERY` requires
explicit enablement, provisioning and an actual bounded API read.

when enabled, `credential.nix` owns `google_places_api_key`. provision that
actual encrypted value in the owner's SOPS file; set
`my.goplaces.credential.sopsFile` when using another encrypted file. the default
is adjacent `secrets.yaml` if it exists, otherwise null. missing provisioning
fails evaluation. no key or plaintext placeholder is included here. follow
[secret ownership](../../SECRETS.md).

`my.goplaces.apiKeyFile` retains intentional external credential ownership.
when supplied, it takes precedence and the local SOPS owner is not required.
the declared path must be absolute and outside `/nix/store`; at invocation the
shared private-file helper requires a nonempty file with no group/other access.
keys are loaded into the child process environment, never into Nix values or
shell profiles. an external key file continues to wrap the CLI even with the
integration disabled, but readiness still fails until explicitly enabled.

setup also requires Places API (New), billing/quota and restrictions suitable
for server-side requests. provisioning a file proves none of those. no
activation or verification makes Google calls or modifies credential state.

manual readiness, only after approving the potentially billable probe:

```sh
goplaces-auth ready 'coffee in São Paulo'
```

this runs one `search QUERY --limit 1 --json --timeout 10s`, with a 15-second
subprocess ceiling. Places search may incur charges even with one result;
result count is not a cost cap. output is a fixed sanitized summary and the
private response is discarded. failure does not relax restrictions or retry.
the probe verifies Places search only, not Routes API or every Places feature.
endpoint overrides are removed so readiness cannot succeed against a mock
endpoint inherited from the shell.

small Nix exec wiring calls the live absolute
`${my.paths.commonplace}/01_files/nix/modules/goplaces/auth.ts`; native code and
`../tool-auth/process.ts` are not copied into the store. both must exist in the
live checkout. the version/flags and `results` JSON shape are pinned to
[goplaces v0.4.14](https://github.com/openclaw/goplaces/tree/v0.4.14),
[search command](https://github.com/openclaw/goplaces/blob/v0.4.14/internal/cli/search.go)
and [response types](https://github.com/openclaw/goplaces/blob/v0.4.14/internal/places/types.go).

local verification: `node --test modules/goplaces/auth.test.ts`. tests use
private temporary fixture files and mocked subprocesses; no billable probe.
