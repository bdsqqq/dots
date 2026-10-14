# editable module files

Nix makes sure a host has what a feature needs. it does not make native edits
depend on rebuilding the computer. this applies to every module: CLIs, apps,
services, editors, compositors, and agent tools.

this is the target contract; the [audit](agent-surface-audit.md) records existing
departures that still need migration.

keep installation, native configuration, and any useful agent guidance together:

```text
modules/<feature>/
├── default.nix
├── <native-config-file>   # only when configuration is needed
└── SKILL.md               # only when agent guidance adds useful decisions
```

`default.nix` owns prerequisites, installation, links, and service wiring.
keep small package definitions inline; a separate `package.nix` is not mandatory.
when a skill is useful, expose it through the local shared discovery path
`~/.config/agents/skills/<feature>/SKILL.md`. keep the canonical file beside
the module; `modules/agents/skills/<feature>/SKILL.md` is a relative symlink
to `../../../<feature>/SKILL.md`. the agent module links the collection root
to all four [agent discovery aliases](agents/README.md#source-versus-installed).
do not add descendant `home.file` entries beneath those linked roots.
discovery does not install a package: hosts still import feature modules explicitly.

## one settings file, not two

when configuration is needed, keep the native file beside `default.nix` and link
it out of store into the location the program actually uses. the program and user edit
the same tracked file. [Ghostty's module](ghostty/default.nix#L7) selects native
files under [its config directory](ghostty/config), then links them out of store
at [the consumed paths](ghostty/default.nix#L19). that wiring is a source example;
it does not prove every native write preserves the link.

do not serialize editable preferences with `home.file.*.text` or an inline
`programs.*.settings` block. do not add a config file to fill out the directory.
keep JSON, TOML, YAML, INI, KDL, and other native config in their own files, not
strings inside `.nix`. script bodies, SQL, HTML, and styles also belong in their
native files. short commands that wire those files into installation or services
can remain in Nix.

Nix options for packages, ports, dependencies, permissions, and service wiring
remain Nix. prefer arguments, environment, runtime credential paths, or native
includes for host-specific inputs rather than replacing the whole editable
configuration with an immutable generated snapshot. a template that produces
an immutable config does not, by itself, satisfy the live-file contract.

do not reset program-written settings on every activation. an unavoidable
generated/immutable configuration boundary needs an explained contract and
agreement, not a silent exception for services.

check the consumer before linking. some programs replace a file by atomic rename,
which can replace the symlink instead of updating its target. test an ordinary
native settings write in isolated state and confirm both the link and repository
file remain correct. link a containing directory only when everything the program
writes there is safe to track; token stores and caches make that inappropriate.

preserve an existing native file when introducing a link. inspect and reconcile
it before activation; do not use `force = true` to discard unrelated settings.
test JSON/TOML/YAML with the consumer's parser and relevant write/reload path.
document any unsupported live-edit contract instead of silently deploying a copy.

## credentials are not preferences

follow [SOPS credential ownership](../SECRETS.md). add adjacent `credential.nix`
and encrypted `secrets.yaml` only when this module owns a required credential.
reuse an existing owner for a shared credential.

plaintext tokens, refresh tokens, linked-device databases, histories, and caches
do not belong in tracked settings. if a program mixes secrets into its config, leave
that private native file writable outside Git rather than inventing a second
configuration format. use a separate nonsecret file only if the program supports it.

provision persistent credentials through SOPS where supported. trace renewal
and export/import behavior before treating a mutable token as a static secret.
never reset newer tool-written authorization state on every activation.

## guidance and verification

skills describe conditional workflows: account choice, bounded reads, platform
requirements, failure handling, and when a different tool is needed. do not
copy a whole upstream skill collection or create one skill per ordinary command.

keep the exact `SKILL.md` casing and a name matching the module directory.
use the [skill authoring procedure](agents/skills/designing-agent-skills/SKILL.md).
check a colocated source with:

```sh
node --experimental-strip-types modules/agents/check-skills.ts --root modules/gog
```

also inspect installed discovery, executable availability, and positive,
negative, and overlapping requests. static loading is not model selection or
proof of authenticated access. report those separately.

hosts import feature modules explicitly; agent guidance uses [the agent module](agents/default.nix).
do not make installing general guidance implicitly install every integration.
keep graphical/app-specific additions in their existing module and gate platform
requirements there. imported does not mean activated, authenticated, or paired.

evaluate the affected native host and build the smallest affected package or
activation artifact required by [the repository verification policy](../AGENTS.md).
do not activate hosts, authorize accounts, or publish merely to verify wiring.
