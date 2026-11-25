# claude code subscription token

on `mbp-m2`, Pi and T3 use the local Claude Code login via `claude-pi`.
a stale setup token overrides that login, so the wrapper clears it. if the
local login expires, run `claude auth login` as the user running Pi.

other configured hosts still use the shared `claude setup-token`, an exception
to [inference brokering](../cli-proxy-api/README.md) for headless use. where a
local login is available, `my.claudeCode.credential.required = false` opts out
of provisioning and using the shared token.

`claude-pi auth status` can report a revoked or expired token as logged in.
check with a real request: `claude-pi -p --tools '' --no-session-persistence 'Reply with just OK.'`.

## rotate

```sh
claude setup-token
pbpaste | jq -Rs 'rtrimstr("\n")' \
  | sops set modules/claude-code/secrets.yaml '["claude_code_oauth_token"]' --value-stdin
```

commit, then revoke the old token at claude.ai/settings/claude-code.
