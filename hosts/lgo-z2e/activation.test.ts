import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("cold home activation waits for networking; Rex ordering has no boot cycle", {
  skip: process.platform !== "linux" || process.arch !== "x64",
}, () => {
  const root = process.env.ACTIVATION_FLAKE ?? fileURLToPath(new URL("../../", import.meta.url));
  const expression = `let
    flake = builtins.getFlake ${JSON.stringify(root)};
    c = flake.nixosConfigurations.lgo-z2e.config;
    home = c.systemd.services.home-manager-bdsqqq;
  in {
    rexContract = import ${JSON.stringify(`${root}/modules/rex/test.nix`)} { inherit flake; };
    after = home.after;
    wants = home.wants;
    timeout = home.serviceConfig.TimeoutStartSec;
    launcherEnabled = c.home-manager.users.bdsqqq.programs.vicinae.systemd.enable;
    launcherAutostart = c.home-manager.users.bdsqqq.programs.vicinae.systemd.autoStart;
    startup = map (command: command.argv) c.home-manager.users.bdsqqq.programs.niri.settings.spawn-at-startup;
    units = builtins.listToAttrs (map (name: {
      inherit name;
      value = c.systemd.units.\${name}.text;
    }) [ "rex-apply.path" "rex-apply.service" "rex-install.service" ]);
  }`;
  const c = JSON.parse(execFileSync("nix", ["eval", "--impure", "--json", "--no-write-lock-file", "--expr", expression], {
    encoding: "utf8", timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
  }));
  assert.equal(c.rexContract, true);
  for (const unit of ["network-online.target", "NetworkManager.service", "NetworkManager-wait-online.service"]) {
    assert.ok(c.after.includes(unit));
  }
  assert.ok(c.wants.includes("network-online.target"));
  assert.equal(c.timeout, "30min");
  assert.equal(c.launcherEnabled, true);
  assert.equal(c.launcherAutostart, true);
  assert.ok(!c.startup.some((argv: string[]) => argv[0].endsWith("/vicinae") && argv.includes("server")));

  const dir = mkdtempSync(join(tmpdir(), "lgo-activation-"));
  try {
    // Keep the real generated Rex dependencies. Only commands are substituted:
    // this checks systemd's implicit path/service edges without executing tools.
    for (const [name, text] of Object.entries(c.units) as [string, string][]) {
      writeFileSync(join(dir, name), text.replace(/^ExecStart=.*$/gm, "ExecStart=/run/current-system/sw/bin/true"));
    }
    for (const name of ["sysinit.target", "shutdown.target", "paths.target"]) {
      writeFileSync(join(dir, name), "[Unit]\nDefaultDependencies=no\n");
    }
    writeFileSync(join(dir, "basic.target"), "[Unit]\nDefaultDependencies=no\nRequires=paths.target\nAfter=paths.target\n");
    writeFileSync(join(dir, "default.target"), "[Unit]\nDefaultDependencies=no\nRequires=basic.target rex-apply.path\n");
    const verify = () => spawnSync("systemd-analyze", ["verify", "--man=no", "--generators=no",
      join(dir, "default.target"), ...Object.keys(c.units).map((name) => join(dir, name)),
    ], { encoding: "utf8", timeout: 30_000, env: { ...process.env, SYSTEMD_UNIT_PATH: dir } });
    const valid = verify();
    assert.equal(valid.status, 0, valid.stderr);
    writeFileSync(join(dir, "rex-apply.path"), c.units["rex-apply.path"] + "\n[Unit]\nAfter=rex-install.service\nRequires=rex-install.service\n");
    const broken = verify();
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /cycle|cyclic/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
