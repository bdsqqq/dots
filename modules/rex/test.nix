{ flake }:
let
  lib = flake.inputs.nixpkgs.lib;
  linuxHosts = builtins.attrNames flake.nixosConfigurations;
  checkLinux = name:
    let
      cfg = flake.nixosConfigurations.${name}.config;
      login = cfg.services.rex.loginServer;
      bootstrap = flake.inputs.rex.packages.${cfg.nixpkgs.hostPlatform.system}.rex;
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
    assert cfg.programs.nix-ld.enable;
    assert cfg.systemd.services.rex-login-server.environment.NIX_LD == "/run/current-system/sw/share/nix-ld/lib/ld.so";
    assert builtins.elem "rex-install.service" cfg.systemd.services.rex-login-server.requires;
    assert lib.hasInfix "[ ! -e /usr/local/bin/rex ] && [ ! -L /usr/local/bin/rex ]" cfg.systemd.services.rex-install.script;
    assert lib.hasInfix "--apply-only" cfg.systemd.services.rex-install.script;
    assert lib.hasInfix (builtins.unsafeDiscardStringContext (toString bootstrap.src)) cfg.systemd.services.rex-install.script;
    assert !(lib.hasInfix (builtins.unsafeDiscardStringContext "${bootstrap}/bin/rex") cfg.systemd.services.rex-install.script);
    assert lib.hasInfix "/bin/ln \"$seed/rex\" /usr/local/bin/rex" cfg.systemd.services.rex-install.script;
    assert cfg.systemd.timers.rex-update.timerConfig.OnUnitInactiveSec == "15min";
    assert cfg.systemd.paths.rex-apply.pathConfig.PathChanged == "/usr/local/bin/rex";
    assert lib.hasInfix "--apply-only" cfg.systemd.services.rex-apply.serviceConfig.ExecStart;
    assert cfg.systemd.services.rex-update.environment.NIX_LD_LIBRARY_PATH == "/run/current-system/sw/share/nix-ld/lib";
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
