# claude code subscription token

one `claude setup-token` login powers pi-claude-code on every host. it is a
deliberate exception to [inference brokering](../cli-proxy-api/README.md):
claude code only runs through its own official cli, so requests can't move to a
credential owner, and per-host browser logins don't survive headless hosts.
anthropic issues this token for exactly that case. it bills the subscription,
not api credits.

only claude processes see the token. `claude-pi` reads the secret and execs the
real cli; `PI_CLAUDE_CODE_COMMAND` points pi at it. shells, pi, and t3 get only
that path, never the token, so t3's credential sync skips this secret. the path
reaches shells through the session environment, linux t3 through a systemd
drop-in, and mac t3 through its synced `service.env` (only where credential sync
is on). anything else falls back to the host's own login.

`claude auth status` reports any token as logged in without contacting
anthropic. a revoked or expired token still lists models, and fails on the
first request.

## rotate (yearly, or after a leak)

```sh
claude setup-token   # approve in a browser; prints sk-ant-oat01-…
pbpaste | jq -Rj 'rtrimstr("\n")' | jq -Rs . \
  | sops set modules/claude-code/secrets.yaml '["claude_code_oauth_token"]' --value-stdin
```

run from the repo root after copying the token, then commit. `sops set` wants a
json value, hence the quoting. hosts pick it up on their next upgrade. revoke
the old one at claude.ai/settings/claude-code.
