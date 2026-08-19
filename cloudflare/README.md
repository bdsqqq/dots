# cloudflare control plane

opentofu owns the cloudflare resources whose drift can break public ingress:
the tunnel identity, dns route, and access application. nix continues to own
the connector processes and their local tunnel routing.

state is committed because this is a small, public configuration repository.
opentofu encrypts it before writing; the passphrase and private access audience
remain outside git. github actions is the only apply authority so two machines
cannot overwrite the local backend concurrently.

do not use terraform against this state. its encryption metadata is
opentofu-specific, and alternating state writers defeats the serialization
boundary.
