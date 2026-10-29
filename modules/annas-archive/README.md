# anna: index search and member download urls

`anna search` signs into Anna’s Archive and searches its actual file index.
results include MD5s, languages, formats and sizes—not substitute catalog
records. search never resolves or downloads a file. account access stays
disabled until `my.annasArchive.enable = true`; installation and activation
make no authenticated requests.

## provision

this uses the **account secret key**, not a scoped API token. it is a login
credential. keep it out of chat, command arguments, Nix values and shell history.

1. run `sops modules/annas-archive/secrets.yaml` yourself. put the real key in
   `annas_archive_key` through the private editor. only encrypted text belongs
   in git.
2. set `my.annasArchive.enable = true` in the desired host.
3. activate through the normal host workflow, then run `anna doctor`.

`credential.nix` owns that adjacent encrypted file and decrypts it to a runtime
file owned by `bdsqqq`, mode `0400`. missing provisioning fails evaluation when
enabled. `my.annasArchive.credential.sopsFile` selects another encrypted source.
an externally provisioned private file is also supported:

```nix
my.annasArchive = {
  enable = true;
  apiKeyFile = "/private/path/to/annas-account-key";
};
```

that overrides the local SOPS owner. the file must be nonempty, absolute,
outside the Nix store and inaccessible to group/other users. private SOPS
symlinks work. the key is read at invocation, never embedded in generated
scripts or exported as an environment value.

## use

```sh
anna search 'the design of everyday things'
anna search 'interface design' --json
anna search 'design' --format 'epub > pdf > *' --language 'en > pt > *'
anna search 'design' --all --pages 3 --limit 50
anna doctor
anna resolve FILE_MD5
anna resolve FILE_MD5 --path-index 0 --domain-index 1
anna ready FILE_MD5
```

`doctor` is offline: it checks preferences and local provisioning, not remote
membership. `resolve` prints JSON containing `download_url`; it does not fetch
the file. `ready` makes the same request but discards the URL. **both may consume
download allowance.** use a result’s 32-character MD5 only when you intend that
request. signed download URLs are private capabilities too.

## signed-in search

anonymous `/search` requests were blocked from this connection; signed-in
requests returned index results. search posts the account key to `/account/`
on the configured Anna origin and keeps its session cookie in memory for that
invocation. it then fetches search HTML without executing scripts, fetching
covers or calling `fast_download`. there is no RapidAPI dependency or separate
provider account. the authentication flow was informed by
[bitesized/annas-archive-api](https://github.com/bitesized/annas-archive-api/blob/main/lib/annas.js).
this is a web adapter, **not an official search API**; markup changes can break it.

search fetches up to 2 pages of 50 records by default. `--pages 1..5` changes
the fetch budget; `--limit 1..100` changes displayed results only (default 20).
pages are sequential, at least a second apart, with no retries or mirror fallback.
repeated MD5s are deduplicated and reported. malformed cards are reported;
challenges and missing result markup fail rather than becoming “no matches.”
Anna’s unrelated partial-match recommendations are excluded, including those
shown after an explicit empty primary search.

coverage is always **fetched pages only**. no next-page link is not proof of
complete coverage; totals are not invented from client-side counters. an index
record is not proof that its download currently works. no availability probe
runs automatically.

## preferences

[preferences.conf](preferences.conf) is read on every search and by `doctor`.
edits take effect on the next invocation, without activation or reload:

```text
language: en, pt-BR > pt > *
format: pdf > epub > * > mobi
```

PDF is preferred; EPUB is secondary. commas tie; `>` lowers preference.
explicit values reserve their tier, so `*` never pulls mobi up. the first two tiers are visible; deeper tiers are fallback-only.
language is considered first. within that language pool, any higher-tier format
suppresses mobi. the best surviving language/format pair is normal; lower visible
pairs are dimmed and marked `[secondary]`. if higher choices are absent, the best
surviving pair is promoted to normal. these decisions cover fetched candidates only.

`--all` exposes hidden/unranked records with labels. `--json` reports numeric
tiers and display classifications without ANSI. `NO_COLOR` disables ANSI;
`FORCE_COLOR=1` enables it unless `NO_COLOR` is set.

language ranges belong to [search.ts](search.ts): `en` includes `en-US`, while a
specific region reserves its own tier. bare Portuguese stays `pt`; it is not
guessed to be Brazilian. missing metadata uses `*`, not an inferred preferred
value. without a wildcard, unlisted values stay hidden unless `--all` is used.

`--language` and `--format` override one saved rule. `--preferences FILE` selects
another file; Nix can set `my.annasArchive.preferencesFile`. invalid, missing,
duplicate or unknown rules fail before requests. both `language` and `format`
are required. [preferences.ts](preferences.ts) is still one portable,
dependency-free TypeScript file; its jsdoc defines the grammar and diagnostics.

## trust and live source

`my.annasArchive.baseUrl` defaults to `https://annas-archive.gl`. changing it
explicitly trusts that origin with your account secret: verify it independently.
only HTTPS origins are accepted. login may return a same-origin redirect, which
is inspected but never followed. search and resolution reject redirects. keys,
cookies, raw server bodies and private network diagnostics are not logged.
successful results reflecting the key or session-cookie values are rejected too.
requests have 15-second timeouts; search HTML is bounded to 2 MiB and member JSON
to 64 KiB. cookies are bounded and discarded when the process exits.

the Nix wrapper invokes editable
`${my.paths.commonplace}/01_files/nix/modules/annas-archive/cli.ts` with Node 24.
activation installs dependencies with pnpm from that same live directory and
lockfile. native dependency edits still use `pnpm` normally; ordinary source or
preference edits need no activation. Nix wiring changes do. no source/config is
replaced with an immutable snapshot. see [secret ownership](../../SECRETS.md#adding-secrets).

## checks

```sh
(cd modules/annas-archive && pnpm install --frozen-lockfile)
node --test modules/annas-archive/*.test.ts modules/tool-auth/process.test.ts
tsc -p modules/annas-archive/tsconfig.json
tsc --noEmit --strict --target ES2020 --module ES2020 --lib ES2020 modules/annas-archive/preferences.ts
nix eval --json --impure --expr 'let f = builtins.getFlake ("path:" + builtins.toString ./.); in import ./modules/annas-archive/test.nix { lib = f.inputs.nixpkgs.lib; }'
```

typechecking needs the existing Node typings; a fresh worktree can point
`--typeRoots` at the installed toolchain’s `@types`. `skipLibCheck` skips
linkedom’s incomplete browser-interface declarations, not our TypeScript.
unit tests inject fake credentials/responses. the CLI e2e test maps only network
transport to a loopback server and exercises real login, private-file checks,
HTML parsing, live preference edits and rendering. [fixtures](fixtures/README.md)
retain reduced, credential-free live markup. deterministic checks never contact
Anna or consume allowance. live authenticated probes are separate.

Nix fixtures check disabled/missing provisioning, external-file and SOPS ownership,
and unsafe configuration—not decryption or entitlement. host evaluation and the
home-manager activation-package build cover wiring and generated installation
scripts; neither activates the host. the official member endpoint is documented
in the [FAQ](https://annas-archive.gl/faq#api) and
[self-documenting endpoint](https://annas-archive.gl/dyn/api/fast_download.json).
