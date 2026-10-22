# jev credential

create the owner-local encrypted file from the repository root:

```sh
sops modules/jev/secrets.yaml
```

in the SOPS editor, add `jev_api_key` with the actual API key and save. do not
put the plaintext key in a Nix file, shell command or chat. no placeholder
`secrets.yaml` is provided: importing the module is safe without a credential;
requesting it requires the real encrypted file.

consumers import the owner and request its runtime file:

```nix
{ config, ... }:
{
  imports = [ ../jev ];
  my.jev.credential.required = true;

  # use config.sops.secrets.jev_api_key.path in the consumer's credential wiring.
}
```

an existing encrypted source can instead be selected with
`my.jev.credential.sopsFile`. the key is decrypted as a user-owned `0400` file;
read it at runtime, not with `builtins.readFile` during evaluation. nothing is
exported globally, and this module does not install a client or contact Jev.

`.sops.yaml` initially grants only the personal recipient access. when selecting
a remote consumer, add that host's recipient to this owner's rule and run
`sops updatekeys modules/jev/secrets.yaml`. imports do not grant decryption access
or activate a host. follow the repository's [SOPS convention](../../SECRETS.md)
for activation and credential handling.
