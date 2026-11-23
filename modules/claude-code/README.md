# claude code subscription token

one `claude setup-token` powers pi-claude-code on every host. an exception to
[inference brokering](../cli-proxy-api/README.md): claude only runs through its
own cli, so requests can't move to an owner, and headless hosts can't do a
browser login.

`claude auth status` reports any token as logged in without checking it. a
revoked or expired token still lists models and fails on the first request.

## rotate

```sh
claude setup-token
pbpaste | jq -Rs 'rtrimstr("\n")' \
  | sops set modules/claude-code/secrets.yaml '["claude_code_oauth_token"]' --value-stdin
```

commit, then revoke the old token at claude.ai/settings/claude-code.
