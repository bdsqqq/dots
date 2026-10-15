import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Synthetic credentials only: generating a URL and rejecting a wrong state
// must neither contact Google nor consume a real user's pending authorization.
test("native SSH consent persists private PKCE state and rejects an unrelated callback", {
  skip: !process.env.GOG_TEST_BINARY && "set GOG_TEST_BINARY to the pinned native CLI",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "gog-headless-"));
  try {
    const env = {
      HOME: root, PATH: process.env.PATH,
      XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
      GOG_KEYRING_BACKEND: "file", GOG_KEYRING_PASSWORD: "synthetic-fixture-password",
    };
    const account = "fixture@example.test";
    const base = ["--no-input", "--json", "--client", "fixture", "--account", account];
    const call = (args: string[], input?: string) => spawnSync(process.env.GOG_TEST_BINARY!, [...base, ...args], {
      env, input, encoding: "utf8", timeout: 10_000,
    });
    const credentials = JSON.stringify({ installed: {
      client_id: "fixture.apps.googleusercontent.com", client_secret: "fixture-secret",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
    } });
    const imported = call(["auth", "credentials", "set", "-"], credentials);
    assert.equal(imported.status, 0, "native file-keyring bootstrap failed");
    assert.equal(JSON.parse(imported.stdout).client_secret_in_keyring, true);

    const files = () => readdirSync(root, { recursive: true })
      .map(name => join(root, name)).filter(file => statSync(file).isFile());
    const before = new Set(files());
    const consent = ["auth", "add", account, "--services", "gmail,calendar", "--readonly", "--force-consent", "--remote"];
    const started = call([...consent, "--step", "1", "--timeout", "15m"]);
    assert.equal(started.status, 0, "native remote consent start failed");
    const url = Object.values(JSON.parse(started.stdout))
      .find(value => typeof value === "string" && value.startsWith("https://accounts.google.com/"));
    assert.equal(typeof url, "string");
    const query = new URL(url as string).searchParams;
    assert.equal(query.get("access_type"), "offline");
    assert.equal(query.get("code_challenge_method"), "S256");
    assert.ok(query.get("code_challenge"));
    const scopes = new Set(query.get("scope")!.split(" "));
    for (const required of ["gmail.readonly", "calendar.readonly"]) {
      assert.ok(scopes.has(`https://www.googleapis.com/auth/${required}`));
    }
    const allowed = new Set(["email", "openid", ...["userinfo.email", "gmail.readonly", "calendar.readonly"]
      .map(scope => `https://www.googleapis.com/auth/${scope}`)]);
    assert.ok([...scopes].every(scope => allowed.has(scope)));
    const redirect = new URL(query.get("redirect_uri")!);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname));
    const state = query.get("state");
    assert.ok(state);
    const pending = files().filter(file => !before.has(file) && readFileSync(file).includes(state));
    assert.ok(pending.length > 0, "step 1 did not persist pending state");
    const saved = new Map(pending.map(file => [file, readFileSync(file)]));
    for (const file of pending) assert.equal(statSync(file).mode & 0o077, 0);

    redirect.searchParams.set("code", "fixture-invalid-code");
    redirect.searchParams.set("state", "fixture-invalid-state");
    const rejected = call([...consent, "--step", "2", "--auth-url", redirect.href]);
    assert.ok(rejected.status !== null && rejected.status !== 0);
    assert.match(rejected.stderr, /state/i);
    for (const [file, contents] of saved) assert.deepEqual(readFileSync(file), contents);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
