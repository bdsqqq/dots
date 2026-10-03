import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  docs,
  manifest,
  pi,
  probeEnvironment,
  repository,
  tools,
  validateConfigs,
  validateManifest,
} from "./probes.ts";

function temporary(fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "ci-probes-test-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function put(root: string, path: string, text: string) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, text);
}
function configFixture(root: string) {
  for (const file of ["settings.json", "tool-policy.json", "keybindings.json", "models.json"])
    put(root, `modules/pi/${file}`, readFileSync(join(repository, "modules/pi", file), "utf8"));
  put(
    root,
    "modules/agents/bds-pi.json",
    readFileSync(join(repository, "modules/agents/bds-pi.json"), "utf8"),
  );
}
function consumerFixture(root: string) {
  configFixture(root);
  put(root, "config/global-agents.md", "GLOBAL_GUIDANCE_FIXTURE\n");
  put(
    root,
    "modules/pi/package.json",
    readFileSync(join(repository, "modules/pi/package.json"), "utf8"),
  );
  symlinkSync(
    join(repository, "modules/pi/node_modules"),
    join(root, "modules/pi/node_modules"),
    "dir",
  );
  mkdirSync(join(root, "modules/pi/packages"), { recursive: true });
  symlinkSync(
    join(repository, "modules/pi/packages/core"),
    join(root, "modules/pi/packages/core"),
    "dir",
  );
  cpSync(join(repository, "modules/agents/agents"), join(root, "modules/agents/agents"), {
    recursive: true,
  });
  cpSync(
    join(repository, "modules/pi/packages/extensions/editor/themes"),
    join(root, "modules/pi/packages/extensions/editor/themes"),
    { recursive: true },
  );
  put(
    root,
    "modules/agents/skills/fixture/SKILL.md",
    "---\nname: fixture\ndescription: offline fixture skill\n---\nfixture body\n",
  );
  put(
    root,
    "modules/pi/packages/extensions/fixture/index.ts",
    "export default function(pi) { pi.registerCommand('fixture', { description: 'fixture', handler: async () => {} }); }\n",
  );
  put(
    root,
    "modules/pi/packages/extensions/fixture/package.json",
    '{"name":"fixture","pi":{"extensions":["./index.ts"]}}',
  );
}

test("docs checks inline, reference, image and HTML files; ignores URLs, headings and fenced examples", () =>
  temporary((root) => {
    put(
      root,
      "guide.md",
      "[ok](target.md#unchecked)\n[ref][id]\n[id]: target.md\n![image](image.png)\n<a href='target.md'>ok</a>\n[net](https://invalid.example/no)\n[heading](#no)\n```md\n[example](absent.md)\n```\n",
    );
    put(root, "target.md", "# target\n");
    put(root, "image.png", "fixture");
    const result = docs(["guide.md"], root);
    assert.equal(result.localLinks, 4);
    assert.ok(result.limitations.some((entry) => entry.includes("heading")));
    put(root, "guide.md", "[broken](absent.md)\n");
    assert.throws(() => docs(["guide.md"], root), /broken relative file/);
  }));

test("docs handles escaped spaces, parentheses, unclosed fences and archival exclusions", () =>
  temporary((root) => {
    put(root, "with space.md", "# ok");
    put(root, "file(1).md", "# ok");
    put(
      root,
      "guide.md",
      "[space](<with%20space.md>)\n[nested](file(1).md)\n[archive](sources/absent.md)",
    );
    assert.equal(docs(["guide.md"], root).localLinks, 2);
    assert.equal(docs(["guide.md"], root).unchecked.length, 1);
    put(root, "sources/research.md", "[archival](absent.md)");
    assert.equal(docs(["sources/research.md"], root).localLinks, 0);
    put(root, "guide.md", "~~~md\nexample");
    assert.throws(() => docs(["guide.md"], root), /unclosed Markdown fence/);
    assert.throws(() => docs([], root), /requires at least one/);
  }));

test("docs confines source paths and relative link identities to the candidate", () =>
  temporary((root) => {
    put(root, "candidate/guide.md", "[escape](../external.md)");
    put(root, "external.md", "outside candidate");
    const candidate = join(root, "candidate");
    assert.throws(() => docs(["../external.md"], candidate), /source escapes candidate/);
    assert.throws(() => docs(["guide.md"], candidate), /relative link escapes candidate/);
    put(root, "candidate/guide.md", "[escape](%2e%2e/external.md)");
    assert.throws(() => docs(["guide.md"], candidate), /relative link escapes candidate/);
    symlinkSync(join(root, "external.md"), join(candidate, "linked.md"));
    assert.throws(() => docs(["linked.md"], candidate), /source symlink escapes candidate/);
    put(root, "candidate/guide.md", "[escape](linked.md)");
    assert.throws(() => docs(["guide.md"], candidate), /link symlink escapes candidate/);
  }));

test("trusted CLI --root reads candidate artifacts without executing the candidate guard", () =>
  temporary((root) => {
    put(root, "scripts/ci/probes.ts", 'console.log(\'{"status":"passed","fakeGuard":true}\');');
    put(root, "guide.md", "[broken](missing.md)");
    const trusted = join(repository, "scripts/ci/probes.ts");
    const run = () =>
      spawnSync(process.execPath, [trusted, "--root", root, "docs", "guide.md"], {
        cwd: root,
        env: { PATH: dirname(process.execPath) },
        encoding: "utf8",
        timeout: 10_000,
      });
    const failed = run();
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /broken relative file/);
    assert.ok(!failed.stdout.includes("fakeGuard"));
    put(root, "guide.md", "[ok](target.md)");
    put(root, "target.md", "# target");
    const passed = run();
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(JSON.parse(passed.stdout).localLinks, 1);
  }));

test("manifest validates eligible source entries and actual artifacts/exports", () =>
  temporary((root) => {
    const pkg = {
      pi: { extensions: ["./dist/extensions/fixture.js"] },
      exports: {
        "./extensions/*": { import: "./dist/extensions/*.js", types: "./dist/extensions/*.d.ts" },
      },
    };
    put(root, "modules/pi/package.json", JSON.stringify(pkg));
    put(root, "modules/pi/packages/extensions/fixture/index.ts", "export default () => {}");
    put(root, "modules/pi/packages/extensions/test-utils/index.ts", "");
    put(root, "modules/pi/dist/extensions/fixture.js", "export default () => {}");
    put(root, "modules/pi/dist/extensions/fixture.d.ts", "export default function(): void");
    assert.equal(validateManifest(root).extensions, 1);
    pkg.pi.extensions = [];
    put(root, "modules/pi/package.json", JSON.stringify(pkg));
    assert.throws(() => validateManifest(root), /eligible source/);
    pkg.pi.extensions = ["./dist/extensions/fixture.js"];
    put(root, "modules/pi/package.json", JSON.stringify(pkg));
    rmSync(join(root, "modules/pi/dist/extensions/fixture.d.ts"));
    assert.throws(() => validateManifest(root), /empty export/);
  }));

test("manifest never reports green without a git candidate comparison", () =>
  temporary((root) => {
    put(
      root,
      "modules/pi/package.json",
      JSON.stringify({ pi: { extensions: [] }, exports: { ".": "./dist/index.js" } }),
    );
    mkdirSync(join(root, "modules/pi/packages/extensions"), { recursive: true });
    put(root, "modules/pi/dist/index.js", "export {}");
    assert.throws(() => manifest(root), /committed candidate manifest/);
  }));

test("manifest rejects build drift reported by the git process boundary", () =>
  temporary((root) => {
    put(
      root,
      "modules/pi/package.json",
      JSON.stringify({ pi: { extensions: [] }, exports: { ".": "./dist/index.js" } }),
    );
    mkdirSync(join(root, "modules/pi/packages/extensions"), { recursive: true });
    put(root, "modules/pi/dist/index.js", "export {}");
    put(
      root,
      "bin/git",
      `#!${process.execPath}\nimport assert from 'node:assert/strict'; assert.deepEqual(process.argv.slice(2), ['diff','--exit-code','--','modules/pi/package.json']); console.log('MANIFEST_DRIFT'); process.exitCode=1;\n`,
    );
    chmodSync(join(root, "bin/git"), 0o700);
    const previous = process.env.PATH;
    try {
      process.env.PATH = join(root, "bin");
      assert.throws(() => manifest(root), /MANIFEST_DRIFT/);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  }));

test("environment is an explicit allowlist, not inherited credentials or NODE_OPTIONS", () => {
  const env = probeEnvironment("/temporary");
  assert.equal(env.HOME, "/temporary");
  assert.equal(env.PI_OFFLINE, "1");
  for (const forbidden of [
    "NODE_OPTIONS",
    "OPENAI_API_KEY",
    "PARALLEL_API_KEY",
    "SSH_AUTH_SOCK",
    "GITHUB_TOKEN",
    "AWS_PROFILE",
  ])
    assert.equal(forbidden in env, false);
  assert.equal(env.PI_BDS_CONFIG_PATH === env.PI_BDS_CONFIG_OVERRIDES_PATH, false);
});

for (const file of ["settings", "tool-policy", "models", "keybindings"]) {
  test(`malformed ${file}.json fails before fallback can mask it`, () =>
    temporary((root) => {
      configFixture(root);
      put(root, `modules/pi/${file}.json`, "{broken");
      assert.throws(() => pi(root), SyntaxError);
    }));
}
test("valid JSON with malformed consumer shapes also fails", () =>
  temporary((root) => {
    configFixture(root);
    for (const [file, value] of [
      ["settings", { skills: 42 }],
      ["tool-policy", [{ tool: "*", action: "typo" }]],
      ["models", { providers: [] }],
      ["keybindings", { "app.model.cycleForward": 4 }],
    ] as const) {
      configFixture(root);
      put(root, `modules/pi/${file}.json`, JSON.stringify(value));
      assert.throws(() => validateConfigs(root));
    }
  }));

test(
  "real SDK resource/settings reload and repository consumers work in a temporary candidate",
  { timeout: 25_000 },
  () =>
    temporary((root) => {
      consumerFixture(root);
      const result = pi(root);
      assert.equal(result.status, "passed");
      assert.equal(result.sourceExtensions, 1);
      assert.equal(result.skills, 1);
      assert.ok(result.themes > 0);
      assert.equal(result.prompts, 3);
      assert.equal(result.globalGuidanceBytes, Buffer.byteLength("GLOBAL_GUIDANCE_FIXTURE\n"));
    }),
);

test(
  "SDK global directory discovery loads manifest-selected actual.ts, not a healthy index",
  { timeout: 25_000 },
  () =>
    temporary((root) => {
      consumerFixture(root);
      put(
        root,
        "modules/pi/packages/extensions/fixture/package.json",
        '{"pi":{"extensions":["./actual.ts"]}}',
      );
      put(
        root,
        "modules/pi/packages/extensions/fixture/actual.ts",
        "export default function() { throw new Error('MANIFEST_SELECTED_FAILURE'); }",
      );
      assert.throws(() => pi(root), /MANIFEST_SELECTED_FAILURE/);
    }),
);

test(
  "trusted --root Pi CLI keeps its trusted child guard despite a candidate fake CLI",
  { timeout: 25_000 },
  () =>
    temporary((root) => {
      consumerFixture(root);
      put(root, "scripts/ci/probes.ts", 'console.log(\'{"status":"passed","fakeGuard":true}\');');
      put(
        root,
        "modules/pi/packages/extensions/fixture/package.json",
        '{"pi":{"extensions":["./actual.ts"]}}',
      );
      put(
        root,
        "modules/pi/packages/extensions/fixture/actual.ts",
        "export default function() { throw new Error('TRUSTED_CHILD_SELECTED_FAILURE'); }",
      );
      const result = spawnSync(
        process.execPath,
        [join(repository, "scripts/ci/probes.ts"), "--root", root, "pi"],
        {
          cwd: root,
          env: { PATH: dirname(process.execPath) },
          encoding: "utf8",
          timeout: 25_000,
        },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /TRUSTED_CHILD_SELECTED_FAILURE/);
      assert.ok(!result.stdout.includes("fakeGuard"));
    }),
);

test(
  "SDK global directory discovery loads additional non-index manifest entries",
  { timeout: 25_000 },
  () =>
    temporary((root) => {
      consumerFixture(root);
      put(
        root,
        "modules/pi/packages/extensions/fixture/package.json",
        '{"pi":{"extensions":["./index.ts","./additional.ts"]}}',
      );
      put(
        root,
        "modules/pi/packages/extensions/fixture/additional.ts",
        "export default function(pi) { pi.registerCommand('additional', { handler: async () => {} }); }",
      );
      const result = pi(root);
      assert.equal(result.extensionDirectories, 1);
      assert.equal(result.sourceExtensions, 2);
    }),
);

test(
  "SDK directory discovery also covers manifest-only packages without index.ts",
  { timeout: 25_000 },
  () =>
    temporary((root) => {
      consumerFixture(root);
      rmSync(join(root, "modules/pi/packages/extensions/fixture/index.ts"));
      put(
        root,
        "modules/pi/packages/extensions/fixture/package.json",
        '{"pi":{"extensions":["./actual.ts"]}}',
      );
      put(
        root,
        "modules/pi/packages/extensions/fixture/actual.ts",
        "export default function(pi) { pi.registerCommand('actual', { handler: async () => {} }); }",
      );
      assert.equal(pi(root).sourceExtensions, 1);
    }),
);

for (const entries of [[42], [], ["./deleted.ts"], ["../escape.ts"]]) {
  test(
    `missing or invalid declared package entry fails rather than SDK index fallback: ${JSON.stringify(entries)}`,
    { timeout: 25_000 },
    () =>
      temporary((root) => {
        consumerFixture(root);
        put(
          root,
          "modules/pi/packages/extensions/fixture/package.json",
          JSON.stringify({ pi: { extensions: entries } }),
        );
        assert.throws(
          () => pi(root),
          /(?:invalid package pi.extensions|missing declared extension entry|invalid package extension entry)/,
        );
      }),
  );
}

test(
  "candidate global guidance is loaded by the SDK with exact newline bytes",
  { timeout: 25_000 },
  () =>
    temporary((root) => {
      consumerFixture(root);
      const guidance = "CANDIDATE_GLOBAL_GUIDANCE\r\n\r\nsecond line\r\n";
      put(root, "config/global-agents.md", guidance);
      assert.equal(pi(root).globalGuidanceBytes, Buffer.byteLength(guidance));
      rmSync(join(root, "config/global-agents.md"));
      assert.throws(() => pi(root), /global-agents\.md/);
    }),
);

test(
  "skill identity uses real paths while canonical-case enforcement stays separate",
  { timeout: 25_000 },
  () =>
    temporary((root) => {
      consumerFixture(root);
      const skill = join(root, "modules/agents/skills/fixture");
      rmSync(join(skill, "SKILL.md"));
      put(
        root,
        "modules/agents/skills/fixture/body.md",
        "---\nname: fixture\ndescription: identity fixture\n---\nbody\n",
      );
      symlinkSync("body.md", join(skill, "SKILL.md"));
      assert.equal(pi(root).skills, 1);
    }),
);

test("case-folded physical skill.md is recognized by real SDK identity", { timeout: 25_000 }, (t) =>
  temporary((root) => {
    consumerFixture(root);
    rmSync(join(root, "modules/agents/skills/fixture/SKILL.md"));
    put(
      root,
      "modules/agents/skills/fixture/skill.md",
      "---\nname: fixture\ndescription: casefold fixture\n---\nbody\n",
    );
    if (!existsSync(join(root, "modules/agents/skills/fixture/SKILL.md"))) {
      t.skip("case-sensitive filesystem; canonical-case enforcement belongs to check-skills");
      return;
    }
    assert.equal(pi(root).skills, 1);
  }),
);

test(
  "missing required agent prompt is detected by the real prompt consumer",
  { timeout: 25_000 },
  () =>
    temporary((root) => {
      consumerFixture(root);
      rmSync(join(root, "modules/agents/agents/agent.amp.finder.md"));
      assert.throws(() => pi(root), /missing required agent prompt/);
    }),
);

test("missing selected theme cannot silently fall back", { timeout: 25_000 }, () =>
  temporary((root) => {
    consumerFixture(root);
    rmSync(join(root, "modules/pi/packages/extensions/editor/themes/unboxed-dark.json"));
    assert.throws(() => pi(root), /missing selected candidate theme/);
  }),
);

test("real SDK source registration error is nonzero", { timeout: 25_000 }, () =>
  temporary((root) => {
    consumerFixture(root);
    put(
      root,
      "modules/pi/packages/extensions/fixture/index.ts",
      "export default function() { throw new Error('REGISTRATION_FAILURE'); }",
    );
    assert.throws(() => pi(root), /REGISTRATION_FAILURE/);
  }),
);

test("real SDK second reload failure is nonzero", { timeout: 25_000 }, () =>
  temporary((root) => {
    consumerFixture(root);
    put(
      root,
      "modules/pi/packages/extensions/fixture/index.ts",
      "import {readFileSync} from 'node:fs'; export default function() { const settings=JSON.parse(readFileSync(process.env.PI_CODING_AGENT_DIR+'/settings.json','utf8')); if (!settings.quietStartup) throw new Error('RELOAD_FAILURE'); }",
    );
    assert.throws(() => pi(root), /RELOAD_FAILURE/);
  }),
);

test("network attempt caught by candidate code still fails the probe", { timeout: 25_000 }, () =>
  temporary((root) => {
    consumerFixture(root);
    put(
      root,
      "modules/pi/packages/extensions/fixture/index.ts",
      "export default async function() { try { await fetch('https://invalid.example'); } catch {} }",
    );
    assert.throws(() => pi(root), /unexpected network\/process access/);
  }),
);

test("malformed model entry fails in the real offline model consumer", { timeout: 25_000 }, () =>
  temporary((root) => {
    consumerFixture(root);
    put(
      root,
      "modules/pi/models.json",
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: "http://invalid.example",
            api: "openai-completions",
            models: [{ id: 42 }],
          },
        },
      }),
    );
    assert.throws(() => pi(root), /models consumer/);
  }),
);

test("invalid key syntax is not silently accepted", () =>
  temporary((root) => {
    configFixture(root);
    put(root, "modules/pi/keybindings.json", '{"app.model.cycleForward":"not-a-key"}');
    assert.throws(() => pi(root), /invalid key syntax/);
  }));

test("candidate resource settings cannot escape the temporary home", { timeout: 25_000 }, () =>
  temporary((root) => {
    consumerFixture(root);
    const settings = JSON.parse(readFileSync(join(root, "modules/pi/settings.json"), "utf8"));
    settings.skills = ["/unexpected/live/path"];
    put(root, "modules/pi/settings.json", JSON.stringify(settings));
    assert.throws(() => pi(root), /resource escapes temporary home/);
  }),
);

test(
  "missing/invalid candidate skill is detected instead of a partial green inventory",
  { timeout: 25_000 },
  () =>
    temporary((root) => {
      consumerFixture(root);
      put(
        root,
        "modules/agents/skills/missing-description/SKILL.md",
        "---\nname: missing-description\n---\nbody\n",
      );
      assert.throws(() => pi(root), /missing required candidate skill/);
    }),
);

function toolsFixture(root: string) {
  const workspace = "modules/node-pnpm";
  put(
    root,
    `${workspace}/pi-cli/package.json`,
    '{"name":"@bdsqqq/pi-cli","version":"0.0.0","bin":{"pi":"bin/pi"}}',
  );
  put(
    root,
    `${workspace}/pi-cli/bin/pi`,
    readFileSync(join(repository, workspace, "pi-cli/bin/pi"), "utf8"),
  );
  chmodSync(join(root, workspace, "pi-cli/bin/pi"), 0o700);
  mkdirSync(join(root, workspace, "node_modules/@bdsqqq"), { recursive: true });
  symlinkSync("../../pi-cli", join(root, workspace, "node_modules/@bdsqqq/pi-cli"), "dir");
  put(
    root,
    "modules/pi/node_modules/@earendil-works/pi-coding-agent/package.json",
    '{"name":"@earendil-works/pi-coding-agent","version":"1.0.0","bin":{"pi":"dist/cli.js"}}',
  );
  put(
    root,
    "modules/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    "#!/usr/bin/env node\nthrow new Error('fixture must not execute');",
  );
  chmodSync(
    join(root, "modules/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    0o700,
  );
  mkdirSync(join(root, workspace, "node_modules/.bin"), { recursive: true });
  symlinkSync("../@bdsqqq/pi-cli/bin/pi", join(root, workspace, "node_modules/.bin/pi"));
  for (const [name, command, version] of [
    ["@openai/codex", "codex", "0.157.1"],
    ["t3", "t3", "0.0.33"],
  ]) {
    put(
      root,
      `${workspace}/node_modules/${name}/package.json`,
      JSON.stringify({ name, version, bin: { [command]: "bin/cli.js" } }),
    );
    put(
      root,
      `${workspace}/node_modules/${name}/bin/cli.js`,
      "#!/usr/bin/env node\nthrow new Error('fixture must not execute');",
    );
    chmodSync(join(root, workspace, "node_modules", name, "bin/cli.js"), 0o700);
    symlinkSync(`../${name}/bin/cli.js`, join(root, workspace, "node_modules/.bin", command));
  }
}

const fixtureVersion = (binary: string) =>
  binary.endsWith("/pi") ? "1.0.0" : binary.endsWith("/codex") ? "codex-cli 0.157.1" : "t3 0.0.33";

test("tools binds installed versions to real candidate bin paths with a fresh secret-free environment", () =>
  temporary((root) => {
    toolsFixture(root);
    const homes: string[] = [];
    const result = tools(root, (binary, args, options) => {
      assert.deepEqual(args, ["--version"]);
      assert.equal(options.timeout, 10_000);
      assert.equal(options.killSignal, "SIGKILL");
      assert.ok(binary.startsWith(join(root, "modules/node-pnpm/node_modules/.bin")));
      const env = options.env;
      assert.equal(env.HOME, options.cwd);
      assert.deepEqual(readdirSync(env.HOME), []);
      assert.ok(!homes.includes(env.HOME), "each CLI needs a fresh home");
      homes.push(env.HOME);
      assert.deepEqual(env.PATH.split(delimiter), [dirname(process.execPath), "/usr/bin", "/bin"]);
      assert.equal(env.PI_TELEMETRY, "0");
      assert.equal(env.T3CODE_TELEMETRY_ENABLED, "false");
      assert.equal(env.OTEL_SDK_DISABLED, "true");
      for (const name of [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GITHUB_TOKEN",
        "AWS_PROFILE",
        "NODE_OPTIONS",
        "NODE_PATH",
        "SSH_AUTH_SOCK",
        "HTTP_PROXY",
      ])
        assert.equal(name in env, false, `inherited ${name}`);
      return { status: 0, stdout: fixtureVersion(binary), stderr: "" };
    });
    assert.equal(result.tools.length, 3);
    assert.equal(result.tools[0].packageVersion, "0.0.0");
    assert.equal(
      result.tools[0].expectedVersion,
      "1.0.0",
      "SDK, not wrapper package, is Pi version authority",
    );
    assert.ok(
      homes.every((home) => !existsSync(home)),
      "temporary homes must be cleaned",
    );
  }));

test("tools validates pnpm shell shim target resolution", () =>
  temporary((root) => {
    toolsFixture(root);
    const shim = "modules/node-pnpm/node_modules/.bin/t3";
    rmSync(join(root, shim));
    put(
      root,
      shim,
      '#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/../t3/bin/cli.js" "$@"\n',
    );
    chmodSync(join(root, shim), 0o700);
    assert.equal(
      tools(root, (binary) => ({ status: 0, stdout: fixtureVersion(binary), stderr: "" })).status,
      "passed",
    );
    put(root, shim, '#!/bin/sh\nexec node "$basedir/../@openai/codex/bin/cli.js" "$@"\n');
    assert.throws(
      () =>
        tools(root, () => {
          throw new Error("must not spawn");
        }),
      /wrong bin shim target/,
    );
  }));

test("tools rejects a matching-prefix but wrong CLI version", () =>
  temporary((root) => {
    toolsFixture(root);
    assert.throws(
      () => tools(root, () => ({ status: 0, stdout: "1.0.00", stderr: "" })),
      /CLI version disagrees/,
    );
  }));

for (const command of ["pi", "codex", "t3"]) {
  test(`tools fails a wrong ${command} version against its metadata authority`, () =>
    temporary((root) => {
      toolsFixture(root);
      assert.throws(
        () =>
          tools(root, (binary) => ({
            status: 0,
            stdout: binary.endsWith(`/${command}`) ? "99.99.99" : fixtureVersion(binary),
            stderr: "",
          })),
        /CLI version disagrees/,
      );
    }));
}

for (const failure of [
  { status: 2, stdout: "", stderr: "missing dependency" },
  {
    status: null,
    signal: "SIGKILL",
    error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
    stdout: "",
    stderr: "",
  },
])
  test(`tools fails process boundary ${failure.status === null ? "timeout" : "failure"}`, () =>
    temporary((root) => {
      toolsFixture(root);
      let home = "";
      assert.throws(
        () =>
          tools(root, (_binary, _args, options) => {
            home = options.env.HOME;
            return failure;
          }),
        /failed or timed out/,
      );
      assert.ok(!existsSync(home), "failure must clean its temporary home");
    }));

test("tools fails missing binary or SDK link before attempting a CLI", () =>
  temporary((root) => {
    toolsFixture(root);
    rmSync(join(root, "modules/node-pnpm/node_modules/.bin/codex"));
    assert.throws(
      () =>
        tools(root, () => {
          throw new Error("must not spawn");
        }),
      /ENOENT/,
    );
    symlinkSync(
      "../@openai/codex/bin/cli.js",
      join(root, "modules/node-pnpm/node_modules/.bin/codex"),
    );
    rmSync(join(root, "modules/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"));
    assert.throws(
      () =>
        tools(root, () => {
          throw new Error("must not spawn");
        }),
      /ENOENT/,
    );
  }));

test("tools rejects a Pi wrapper pointed at the stock bundle", () =>
  temporary((root) => {
    toolsFixture(root);
    const wrapper = join(root, "modules/node-pnpm/pi-cli/bin/pi");
    writeFileSync(
      wrapper,
      readFileSync(wrapper, "utf8").replace("dist/cli.js", "dist/bundle/cli.js"),
    );
    assert.throws(
      () =>
        tools(root, () => {
          throw new Error("must not spawn");
        }),
      /unbundled patched SDK/,
    );
  }));
