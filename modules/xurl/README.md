# x native readiness

`my.xurl.integration` defaults to disabled. enabled mode requires exact `app`
and `account` (OAuth2 username without `@`), a private absolute `nativeHome`,
and `nativeStateFile = "${nativeHome}/.xurl/auth.yml"`. native authorization state
stays writable and private; existing authorization requires no static SOPS secret.
`authMode = "native"` is the default. no activation hook imports or resets tokens.

`xurl-ready --local` parses the private native YAML using yq and checks the exact
app and named OAuth2 token. that is offline state validation, not authenticated
readiness. `xurl-ready` performs one bounded `/2/users/me` GET with pinned
`--app APP --auth oauth2 --username ACCOUNT`, validates id/username, and suppresses
both response and stderr. explicit username prevents interactive login fallback.
ambient OAuth credential and endpoint overrides are removed; HOME is explicit.
native refresh may update tokens and is deliberately preserved. revoked tokens,
missing permissions, entitlement/quota failures, malformed data, and wrong identity
cannot pass readiness. each child process has a 15-second bound.

optional `authMode = "bootstrap"` automatically requires the SOPS owner for
`xurl_app`, a JSON string containing `client_id` and `client_secret`.
`my.xurl.credential.sopsFile` defaults to adjacent `secrets.yaml` when present;
otherwise an assertion requires selection. an explicit private `credentialFile`
can instead declare an externally provisioned source without requesting SOPS.
no secret template or token snapshot is installed.

`xurl-ready --bootstrap` is explicit app registration only. pinned v1.3.4 requires
`auth apps add NAME --client-id ID --client-secret SECRET`; no native stdin/import
flag exists. the subprocess uses short-lived argv containing these static values,
without shell interpolation/logging. existing app or legacy state is rejected;
refreshable state is never overwritten. registration still requires a later explicit
native `xurl --app APP auth oauth2 ACCOUNT` consent step. bootstrap never does consent.

sources: [v1.3.4 register](https://github.com/xdevplatform/xurl/blob/v1.3.4/cli/auth.go),
[explicit-user behavior/refresh](https://github.com/xdevplatform/xurl/blob/v1.3.4/auth/auth.go),
[native storage](https://github.com/xdevplatform/xurl/blob/v1.3.4/store/tokens.go),
[environment resolution](https://github.com/xdevplatform/xurl/blob/v1.3.4/config/config.go).
