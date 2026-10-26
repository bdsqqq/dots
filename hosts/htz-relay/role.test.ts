import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

type Role = {
  drvPath: string;
  packages: string[];
  homeFiles: string[];
  activations: string[];
  secrets: string[];
  services: Record<string, boolean>;
  containers: string[];
  automerge: string;
  incidents: {
    enabled: boolean;
    timer: boolean;
    execStart: string;
    stateDirectory: string;
    credentials: string[];
    user: string;
  };
  maintenance: {
    keepOutputs: boolean;
    keepDerivations: boolean;
    gcAutomatic: boolean;
    gcOptions: string;
    gcAfterUpgrade: boolean;
    pressureBytes: number;
    targetBytes: number;
  };
};

const source = process.env.ROLE_FLAKE ?? `path:${fileURLToPath(new URL("../../", import.meta.url))}`;

function evaluate(injectTool = false): Role {
  const expression = `let
    flake = builtins.getFlake ${JSON.stringify(source)};
    base = flake.nixosConfigurations.htz-relay;
    system = ${injectTool ? `base.extendModules { modules = [ ({ pkgs, ... }: {
      home-manager.users.bdsqqq.home.packages = [ pkgs.nodejs_latest ];
    }) ]; }` : "base"};
    cfg = system.config;
    home = cfg.home-manager.users.bdsqqq;
  in {
    drvPath = cfg.system.build.toplevel.drvPath;
    packages = map (p: p.pname or p.name) (cfg.environment.systemPackages ++ home.home.packages);
    homeFiles = builtins.attrNames home.home.file;
    activations = builtins.attrNames home.home.activation;
    secrets = builtins.attrNames cfg.sops.secrets;
    services = {
      ssh = cfg.services.openssh.enable;
      tailscale = cfg.services.tailscale.enable;
      syncthing = cfg.services.syncthing.enable;
      automerge = cfg.systemd.services.syncthing-automerge.enable;
      telemetry = cfg.systemd.services.otelcol-axiom.enable;
      ingress = cfg.my.cloudflareIngress.enable;
      files = cfg.services.copyparty.enable;
    };
    containers = builtins.attrNames cfg.containers;
    automerge = toString cfg.systemd.services.syncthing-automerge.serviceConfig.ExecStart;
    incidents = {
      enabled = cfg.services.axiom-incidents.enable;
      timer = cfg.systemd.timers.axiom-incidents.enable;
      execStart = cfg.systemd.services.axiom-incidents.serviceConfig.ExecStart;
      stateDirectory = cfg.systemd.services.axiom-incidents.serviceConfig.StateDirectory;
      credentials = cfg.systemd.services.axiom-incidents.serviceConfig.LoadCredential;
      user = cfg.systemd.services.axiom-incidents.serviceConfig.User;
    };
    maintenance = {
      keepOutputs = cfg.nix.settings.keep-outputs;
      keepDerivations = cfg.nix.settings.keep-derivations;
      gcAutomatic = cfg.nix.gc.automatic;
      gcOptions = cfg.nix.gc.options;
      gcAfterUpgrade = builtins.elem "nix-gc.service" cfg.systemd.services.nixos-upgrade.unitConfig.OnSuccess;
      pressureBytes = cfg.nix.settings.min-free;
      targetBytes = cfg.nix.settings.max-free;
    };
  }`;
  const result = spawnSync("nix", ["eval", "--offline", "--impure", "--json", "--expr", expression], {
    encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout) as Role;
}

function assertInfrastructureOnly(role: Role): void {
  // Service closures may contain Node; installing its developer bootstrap in a
  // user's profile is a different contract and would recreate the broad role.
  const forbidden = /^(hunkdiff|nodejs|pnpm|mise|gogcli|goplaces|openhue-cli|xurl|wacli|zmx|yazi|fastfetch|httpie|lazygit|neovim|nix-ld)$/;
  assert.deepEqual(role.packages.filter((name) => forbidden.test(name)), [], "relay must not install agent/developer tools");
  const prefixes = [".agents/", ".claude/", ".codex/", ".pi/", ".config/agents/"];
  assert.deepEqual(role.homeFiles.filter((name) => prefixes.some((prefix) => name.startsWith(prefix))), []);
  const bootstrap = ["commonplaceAgents", "installPnpmTools", "installVitePlus", "ensureMiseTools", "installPiExtensionDeps"];
  assert.deepEqual(role.activations.filter((name) => bootstrap.includes(name)), []);
}

const current = evaluate();

test("the full relay derivation evaluates without agent or developer bootstrap", () => {
  assert.match(current.drvPath, /-nixos-system-htz-relay-.*\.drv$/);
  assertInfrastructureOnly(current);
});

test("relay services and all existing application/ingress containers remain enabled", () => {
  for (const [name, enabled] of Object.entries(current.services)) assert.equal(enabled, true, name);
  assert.deepEqual(current.containers.sort(), ["apps", "cloudflare-ingress", "cloudflare-ingress-files", "cloudflare-ingress-t3"]);
  assert.match(current.automerge, /\/bin\/syncthing-automerge$/);
});

test("unused personal-agent credentials are not provisioned by the relay role", () => {
  for (const name of ["gh_token", "hf_token", "artificial_analysis_api_key", "sentry_auth_token"])
    assert.ok(!current.secrets.includes(name), name);
  assert.ok(current.secrets.includes("tailscale_auth_key"));
  assert.ok(current.secrets.includes("axiom/papertrail_token"));
  assert.ok(current.secrets.includes("axiom/host_metrics_token"));
});

test("native Nix collects old generations after upgrades with pressure GC enabled", () => {
  const expected = {
    keepOutputs: false, keepDerivations: false,
    gcAutomatic: true, gcOptions: "--delete-old", gcAfterUpgrade: true,
    pressureBytes: 4 * 1024 ** 3, targetBytes: 8 * 1024 ** 3,
  };
  assert.deepEqual(current.maintenance, expected);
  assert.throws(() => assert.deepEqual({ ...current.maintenance, gcAfterUpgrade: false }, expected));
});

test("incident evaluation is unprivileged, persistent, and wired to both query and ingest credentials", () => {
  assert.equal(current.incidents.enabled, true);
  assert.equal(current.incidents.timer, true);
  assert.match(current.incidents.execStart, /\/bin\/axiom-incidents poll$/);
  assert.equal(current.incidents.stateDirectory, "axiom-incidents");
  assert.equal(current.incidents.user, "bdsqqq");
  const expected = [
    "query-token:/run/secrets/axiom/personal_token",
    "org-id:/run/secrets/axiom/personal_org_id",
    "ingest-token:/run/secrets/axiom/papertrail_token",
  ];
  assert.deepEqual(current.incidents.credentials, expected);
  assert.throws(() => assert.deepEqual(current.incidents.credentials.slice(0, 2), expected));
});

test("the verifier detects an isolated reintroduction of a global developer runtime", () => {
  const broken = evaluate(true);
  assert.throws(() => assertInfrastructureOnly(broken), /relay must not install agent\/developer tools/);
});
