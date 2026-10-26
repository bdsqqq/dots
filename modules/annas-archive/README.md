# anna's archive member api

imports install `anna` on the five interactive hosts that already have the
other research CLIs. authenticated requests stay disabled until
`my.annasArchive.enable = true`. no credential, consent flow, download, or
remote readiness probe runs during installation or activation.

## provision

this uses the **account secret key**, not a separate scoped API token. treat
it as a login credential. do not paste it into chat, command arguments, Nix
values, or shell history.

1. in this checkout, run `sops modules/annas-archive/secrets.yaml` yourself.
   add `annas_archive_key` with your real account secret in the private editor.
   only the encrypted file belongs in git; no placeholder is shipped.
2. enable the integration in the desired host configuration:
   ```nix
   my.annasArchive.enable = true;
   ```
3. activate through the normal host workflow, then run `anna doctor`.

`credential.nix` owns that adjacent encrypted file, decrypting to a runtime
file owned by `bdsqqq`, mode `0400`. missing provisioning fails evaluation
when enabled. an alternative encrypted source can be declared with
`my.annasArchive.credential.sopsFile`.

an intentionally externally provisioned file is also supported:

```nix
my.annasArchive = {
  enable = true;
  apiKeyFile = "/private/path/to/annas-account-key";
};
```

that overrides the local SOPS owner. the file must be nonempty, absolute,
outside the Nix store, and have no group/other permissions; private SOPS
symlinks are supported. credentials are read at invocation, never embedded
in generated scripts or exported as environment values.

## use

```sh
anna --help
anna doctor
anna resolve FILE_MD5
anna resolve FILE_MD5 --path-index 0 --domain-index 1
anna ready FILE_MD5
```

`doctor` is offline and proves only local provisioning. `resolve` makes one
member API request and prints JSON containing `download_url`; it does not
fetch the file. `ready` makes the same request but discards the response.
**both remote commands may consume download allowance.** use a real file's
32-character hexadecimal MD5 only when you intend that request. there are no
automatic retries. treat a returned signed download URL as private, too.

this is URL resolution, **not a search API**. see the official
[FAQ](https://annas-archive.gl/faq#api) and
[self-documenting endpoint](https://annas-archive.gl/dyn/api/fast_download.json).
the API requires `md5` and `key`; optional indices select a collection/server.
account metadata and raw remote error bodies are not printed.

## trust and live source

`my.annasArchive.baseUrl` defaults to `https://annas-archive.gl`. changing it
explicitly trusts that origin with the account secret: verify it independently
before enabling requests. only HTTPS origins are accepted; redirects are
rejected rather than forwarding the credential to another mirror. requests
have a 15-second timeout and responses a 64 KiB bound.

the generated wrapper contains only nonsecret configuration and calls the
editable `${my.paths.commonplace}/01_files/nix/modules/annas-archive/cli.ts`
with Nix's Node 24. it also needs `../tool-auth/process.ts` from that same live
checkout. neither source is copied into the store. ordinary source edits need
no activation; Nix option/wiring changes do. activation does not overwrite
native state. see [secret ownership](../../SECRETS.md#adding-secrets).

## local checks

```sh
node --test modules/annas-archive/cli.test.ts modules/tool-auth/process.test.ts
tsc -p modules/annas-archive/tsconfig.json
nix eval --json --impure --expr 'let f = builtins.getFlake ("path:" + builtins.toString ./.); in import ./modules/annas-archive/test.nix { lib = f.inputs.nixpkgs.lib; }'
```

typechecking needs the existing Node typings available to TypeScript; in a
fresh worktree, point `--typeRoots` at the installed toolchain's `@types`.
tests use private temporary fixture files and injected responses; they never
use a real account or consume allowance. Nix fixtures check missing/disabled,
external-file and SOPS ownership, and unsafe configuration—not decryption or
remote entitlement. host evaluation and the consuming wrapper build cover
the Nix wiring separately.
