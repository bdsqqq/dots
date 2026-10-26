{ flake }:
let
  lib = flake.inputs.nixpkgs.lib;
  linuxHosts = [ "lgo-z2e" "htz-relay" "htz-xfs-lab" ];
  checkLinux = name:
    let
      cfg = flake.nixosConfigurations.${name}.config;
      login = cfg.services.rex.loginServer;
    in
    assert login.enable && !cfg.services.rex.enable;
    assert !login.allowAnonymous;
    assert login.extraListen == [ ];
    assert login.accounts.bdsqqq.principals == [ "tailscale:igorbedesqui@gmail.com" ];
    assert login.defaults."tailscale:igorbedesqui@gmail.com" == "bdsqqq";
    assert login.tailscaleServe.enable;
    assert login.tailscaleServe.httpsPort == 7297;
    assert cfg.sops.secrets.rex_netrc.owner == "root";
    assert cfg.sops.secrets.rex_netrc.mode == "0400";
    assert cfg.nix.settings.netrc-file == cfg.sops.secrets.rex_netrc.path;
    assert lib.hasInfix "login-server" cfg.systemd.services.rex-login-server.serviceConfig.ExecStart;
    assert lib.hasInfix "--https=7297" cfg.systemd.services.rex-tailscale-serve.serviceConfig.ExecStart;
    true;
  withoutTailscale = (flake.nixosConfigurations.htz-xfs-lab.extendModules {
    modules = [ { services.tailscale.enable = lib.mkForce false; } ];
  }).config;
in
assert lib.all checkLinux linuxHosts;
assert !withoutTailscale.services.rex.loginServer.tailscaleServe.enable;
assert withoutTailscale.services.rex.loginServer.enable;
true
