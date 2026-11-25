# claude code subscription token

`claude-pi` uses the shared `claude setup-token` on configured hosts, including
`mbp-m2`. this is an exception to [inference brokering](../cli-proxy-api/README.md)
for headless use. where a local login is available, setting
`my.claudeCode.credential.required = false` opts out of provisioning the shared
token and clears any inherited setup token so it can't override the local login.

`claude-pi auth status` can report a revoked or expired token as logged in.
check with a real request: `claude-pi -p --tools '' --no-session-persistence 'Reply with just OK.'`.

## rotate

```sh
claude setup-token
pbpaste | jq -Rs 'rtrimstr("\n")' \
  | sops set modules/claude-code/secrets.yaml '["claude_code_oauth_token"]' --value-stdin
```

commit, then revoke the old token at claude.ai/settings/claude-code.
