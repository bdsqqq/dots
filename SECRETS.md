# secrets management with sops-nix

encrypted secrets that live safely in git. private keys stay local, encrypted files get committed.

## how it works

- **private keys** never enter the repository; automation gets a scoped key
- **public keys** in `.sops.yaml` (committed)
- **encrypted secrets** have one stable domain owner
- **owner files** are adjacent `credential.nix` and `secrets.yaml` files
- **consumers** import the owner and set its `credential.required` option
- **runtime** decryption via your local key

## setup (once per machine)

### generate age key

```bash
mkdir -p ~/.config/sops/age
age-keygen -o ~/.config/sops/age/keys.txt
```

**never commit this file.**

### get public key

```bash
age-keygen -y ~/.config/sops/age/keys.txt
```

copy the `age1...` output.

### update .sops.yaml

```yaml
keys:
  - &user_bdsqqq age1wzdqusx4v0wpn7lgda4x4tw3qkd4jlcyy89pxrh4g679m0ajadtsh49e6t
creation_rules:
  - path_regex: (^|/)secrets\.yaml$
    key_groups:
      - age:
          - *user_bdsqqq
```

### create secrets

```bash
sops modules/<feature>/secrets.yaml
```

add your actual keys:

```yaml
anthropic_api_key: "your-key-here"
copilot_token: "your-token"
```

save/exit → auto-encrypted.

### rebuild

```bash
sudo darwin-rebuild switch --flake .
```

## daily usage

**edit secrets**: `sops modules/<feature>/secrets.yaml`

**view encrypted**: `cat modules/<feature>/secrets.yaml` (gibberish - safe for git)

## fallback behavior

fallbacks are consumer-specific. the declared `sopsFile` must exist during nix
evaluation. pi's shell wiring preserves an existing environment value when its
runtime secret file is unreadable; do not assume other modules do the same.

### temporary runtime override

```bash
export PARALLEL_API_KEY="temp-key"
```

this bypasses declarative secret management for the current process only.

## backup/recovery

### backup your key

**critical**: store in password manager:

```bash
cat ~/.config/sops/age/keys.txt
```

### lost key recovery

1. `age-keygen -o ~/.config/sops/age/keys.txt`
2. `age-keygen -y ~/.config/sops/age/keys.txt`
3. update `.sops.yaml` with new public key
4. run `sops updatekeys <file>` for every encrypted file the key must decrypt

### new machines

1. generate age key on new machine
2. add public key to `.sops.yaml`
3. run `sops updatekeys <file>` for every encrypted file the machine consumes
4. commit updated secrets

## what gets committed

```
.sops.yaml                       ✓ (public keys)
modules/<feature>/secrets.yaml   ✓ (encrypted)
modules/<feature>/credential.nix ✓ (stable owner and declaration)
modules/<consumer>/*.nix         ✓ (owner import and requirement)
~/.config/sops/age/keys.txt      ✗ (NEVER)
```

## security notes

- encrypted files safe for public repos
- secrets become individual files in `/run/secrets/`
- only your user can read them

## troubleshooting

**"command not found: age-keygen"**  
rebuild first: `sudo darwin-rebuild switch --flake .`

**"failed to decrypt"**

- check key exists: `ls ~/.config/sops/age/keys.txt`
- verify public key matches in `.sops.yaml`
- re-encrypt: `sops updatekeys modules/<feature>/secrets.yaml`

**"no such file: secrets.yaml"**

run the command from the repository root and verify the owning module's encrypted
file exists.

## adding secrets

1. choose the domain that owns the credential. ownership does not change when
   the credential gains another consumer.
2. create or edit the owner's adjacent `secrets.yaml` with `sops`.
3. declare it in the owner's `credential.nix`, gated by a requirement option:
   ```nix
   options.my.feature.credential.required =
     lib.mkEnableOption "the feature credential";

   config = lib.mkIf config.my.feature.credential.required {
     sops.secrets.new_secret = {
       sopsFile = ./secrets.yaml;
       owner = "bdsqqq";
       mode = "0400";
     };
   };
   ```
4. each consumer imports `credential.nix`, sets the requirement when enabled,
   and uses `config.sops.secrets.new_secret.path`. repeated imports are
   deduplicated by the Nix module system.
5. avoid copying plaintext into Nix options or the store. pass the runtime file
   directly where possible; use process-local environment adaptation only when
   the consumer API requires a value.
6. run the ownership and host-closure checks before rebuilding:
   ```bash
   nix build .#checks.aarch64-darwin.credential-ownership
   nix build .#checks.aarch64-darwin.credential-host-closures
   ```

retained future credentials may remain encrypted beside their owner while their
requirement stays false. `modules/secrets/default.nix` is infrastructure only;
it configures age key lookup and does not own credentials.

## automation credentials

automation age keys must be path-scoped in `.sops.yaml`. Cloudflare Actions
receives `CLOUDFLARE_SOPS_AGE_KEY`, whose recipient can decrypt only
`cloudflare/secrets.yaml`; host and personal credential files exclude it.

## refs

- [sops-nix](https://github.com/Mic92/sops-nix)
- [age](https://github.com/FiloSottile/age)
