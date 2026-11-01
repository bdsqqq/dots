import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

interface Ingress {
  enabled: boolean;
  ping: boolean;
  tcp: number[];
  udp: number[];
  tcpRanges: unknown[];
  udpRanges: unknown[];
  trusted: string[];
  interfaces: Record<string, unknown>;
  sshOpen: boolean;
  tailscaleOpen: boolean;
  up: string[];
  set: string[];
  drv: string;
}

function assertPrivate(c: Ingress): void {
  assert.equal(c.enabled, true);
  assert.equal(c.ping, false);
  for (const ports of [c.tcp, c.udp, c.tcpRanges, c.udpRanges]) assert.deepEqual(ports, []);
  assert.deepEqual([...c.trusted].sort(), ["lo", "tailscale0"]);
  // br-apps is a private container bridge, never a public NIC.
  assert.ok(Object.keys(c.interfaces).every((name) => ["tailscale0", "br-apps"].includes(name)));
  assert.equal(c.sshOpen, false);
  assert.equal(c.tailscaleOpen, false);
  for (const flags of [c.up, c.set]) {
    assert.deepEqual(flags.filter((flag) => flag.startsWith("--netfilter-mode")), ["--netfilter-mode=off"]);
  }
  assert.match(c.drv, /\.drv$/);
}

const fixture: Ingress = {
  enabled: true, ping: false, tcp: [], udp: [], tcpRanges: [], udpRanges: [],
  trusted: ["lo", "tailscale0"], interfaces: {}, sshOpen: false, tailscaleOpen: false,
  up: ["--netfilter-mode=off"], set: ["--netfilter-mode=off"], drv: "/nix/store/fixture.drv",
};

test("verifier rejects public ports, public trust, and tailscaled's independent firewall bypass", () => {
  assertPrivate(fixture);
  for (const change of [
    { enabled: false }, { ping: true }, { tcp: [22] }, { udp: [41641] },
    { tcpRanges: [{ from: 1, to: 65535 }] }, { udpRanges: [{ from: 1, to: 65535 }] },
    { trusted: ["lo", "tailscale0", "enp1s0"] }, { interfaces: { enp1s0: { allowedTCPPorts: [22] } } },
    { sshOpen: true }, { tailscaleOpen: true }, { up: [] }, { set: [] },
    { set: ["--netfilter-mode=off", "--netfilter-mode=on"] },
  ]) assert.throws(() => assertPrivate({ ...fixture, ...change }));
});

test("all Hetzner hosts evaluate with private ingress and force their system derivations", {
  skip: process.platform !== "linux" || process.arch !== "x64",
}, () => {
  const root = process.env.PRIVATE_INGRESS_FLAKE ?? fileURLToPath(new URL("../../", import.meta.url));
  const expression = `let
    flake = builtins.getFlake ${JSON.stringify(root)};
    inspect = host: let
      c = flake.nixosConfigurations.\${host}.config;
      f = c.networking.firewall;
      t = c.services.tailscale;
    in {
      enabled = f.enable;
      ping = f.allowPing;
      tcp = f.allowedTCPPorts;
      udp = f.allowedUDPPorts;
      tcpRanges = f.allowedTCPPortRanges;
      udpRanges = f.allowedUDPPortRanges;
      trusted = f.trustedInterfaces;
      interfaces = f.interfaces;
      sshOpen = c.services.openssh.openFirewall;
      tailscaleOpen = t.openFirewall;
      up = t.extraUpFlags;
      set = t.extraSetFlags;
      drv = c.system.build.toplevel.drvPath;
    };
  in builtins.listToAttrs (map (host: { name = host; value = inspect host; })
    [ "htz-relay" "htz-lab" "htz-xfs-lab" ])`;
  const result = execFileSync("nix", ["eval", "--impure", "--json", "--no-write-lock-file", "--expr", expression], {
    encoding: "utf8", timeout: 240_000, maxBuffer: 4 * 1024 * 1024,
  });
  for (const [host, config] of Object.entries(JSON.parse(result) as Record<string, Ingress>)) {
    assertPrivate(config);
    console.log(`${host}: ${config.drv}`);
  }
});
