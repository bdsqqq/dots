# native pi settings

custom extension namespaces now live alongside pi options in
`~/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json`).
there is no runtime reader for `bds-pi.json`, `bds-pi.local.json`, or the
`PI_BDS_CONFIG_PATH` / `PI_BDS_CONFIG_OVERRIDES_PATH` variables.

reads merge defaults, native user settings, then `.pi/settings.json` only when
the caller grants `allowProjectConfig` and supplies `cwd`. a supplied `settings`
snapshot is already resolved: no files are read, including project files.
callers using native `SettingsManager` can supply `getGlobalSettings()` or an
explicitly trusted `getSettings()` snapshot. returned values do not mutate
the snapshot or defaults. reads are fresh; malformed files throw. the retained
schema API still diagnoses invalid values and returns isolated defaults.

namespaced writes preserve sibling keys and write through editable symlinks,
not over them. they are synchronous read/modify/write operations, not transactions
with concurrent settings editors. serialize edits; native pi's public
`SettingsManager` has no arbitrary-key persistence setter.

## explicit legacy import

do not run an import as part of reload, installation, or activation. first inspect
the legacy base and mutable override on the target host, including any old
environment-selected locations. if neither contains surviving custom options,
no import is needed. the removed tracked file contained only obsolete
`sessionsDirs` lists.

when import is needed, make a backup of the editable native settings target and
retain both legacy files. with separate authorization, call
`migrateLegacySettings([basePath, localPath], nativeSettingsPath)` from
[`index.ts`](./index.ts). omit a nonexistent layer rather than passing its path.
paths are explicit; the handler does not discover legacy files.

the import preserves unknown top-level and nested options. mutable legacy values
override base values, including `false`, `""`, and `[]`; existing native values
win conflicts. inspect conflicts before importing if a mutable legacy value
should instead win. malformed/unreadable requested inputs abort before writing;
source files are never removed. repeating the import is idempotent. keep backups
until the relevant extension has been reloaded and its behavior checked.

`sessionsDirs` is no longer consumed by the maintainer. do not translate the
stale T3 provider path into `sessionDir`. native
default sessions stay under the agent directory's `sessions/` workspace
subdirectories. a genuine custom `sessionDir` is a flat directory, relative to
the launching working directory when not absolute; the native session-directory
environment variable overrides it. the maintainer ignores project settings
unless explicitly opted in. no import moves sessions or changes their IDs.
