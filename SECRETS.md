# secrets management with sops-nix

encrypted secrets that live safely in git. private keys stay local, encrypted files get committed.

## how it works

- **private keys** never leave your machine
- **public keys** in `.sops.yaml` (committed)
- **encrypted secrets** in `secrets.yaml` (committed)
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
  - path_regex: secrets\.yaml$
    key_groups:
      - age:
          - *user_bdsqqq
```

### create secrets

```bash
sops secrets.yaml
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

**edit secrets**: `sops secrets.yaml`  
**view encrypted**: `cat secrets.yaml` (gibberish - safe for git)

## fallback behavior

robust by design:

- **secrets.yaml exists**: uses sops → falls back to env vars
- **secrets.yaml missing**: uses env vars only
- **sops broken**: still works via env vars

### bootstrap without secrets

```bash
export ANTHROPIC_API_KEY="temp-key"
sudo darwin-rebuild switch --flake .  # works

# add secrets later
sops secrets.yaml
sudo darwin-rebuild switch --flake .  # now uses sops
```

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
4. `sops updatekeys secrets.yaml`

### new machines

1. generate age key on new machine
2. add public key to `.sops.yaml`
3. `sops updatekeys secrets.yaml`
4. commit updated secrets

## what gets committed

```
.sops.yaml          ✓ (public keys)
secrets.yaml        ✓ (encrypted)
home.nix           ✓ (config)
~/.config/sops/age/keys.txt  ✗ (NEVER)
```

## security notes

- encrypted files safe for public repos
- secrets become individual files in `$XDG_RUNTIME_DIR/secrets/`
- only your user can read them

## troubleshooting

**"command not found: age-keygen"**  
rebuild first: `sudo darwin-rebuild switch --flake .`

**"failed to decrypt"**

- check key exists: `ls ~/.config/sops/age/keys.txt`
- verify public key matches in `.sops.yaml`
- re-encrypt: `sops updatekeys secrets.yaml`

**"no such file: secrets.yaml"**  
fallback handles this - uses env vars instead.

## adding secrets

1. `sops secrets.yaml`
2. declare in `home.nix`:
   ```nix
   sops.secrets.new_secret = {};
   ```
3. use in shell:
   ```nix
   initExtra = ''
     export NEW_SECRET="$(cat ${config.sops.secrets.new_secret.path} 2>/dev/null || echo "$NEW_SECRET")"
   '';
   ```
4. `sudo darwin-rebuild switch --flake .`

## refs

- [sops-nix](https://github.com/Mic92/sops-nix)
- [age](https://github.com/FiloSottile/age)
