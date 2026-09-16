# cloudflare control plane

opentofu owns the cloudflare resources whose drift can break public ingress:
the tunnel identities, dns routes, and access applications. each public app
has an independent tunnel and supervised connector process so one dead origin
cannot withdraw an unrelated app. nix continues to own the connector processes
and their local tunnel routing.

state is committed because this is a small, public configuration repository.
opentofu encrypts it before writing; the passphrase remains outside git.
private access audience membership is canonical ciphertext in `secrets.yaml`.
`tofu-with-secrets` decrypts it into a process-local environment value, so the
plaintext does not enter arguments, plan JSON, or repository files.

pushes that change the declaration reconcile cloudflare and commit the encrypted
state. a daily plan reports dashboard drift without applying it. the api token
is CI-only and scoped to access applications, tunnels, and this zone's dns.
CI decrypts only this file with `CLOUDFLARE_SOPS_AGE_KEY`, whose public
recipient is restricted to the Cloudflare path in `.sops.yaml`.

do not use terraform against this state. its encryption metadata is
opentofu-specific, and alternating state writers defeats the serialization
boundary.
