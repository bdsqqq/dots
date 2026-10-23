{ lib, tailscaleModule ? ./default.nix }:
let
  # Evaluate the actual shared module with only its consumed option contracts.
  # Package stubs avoid builds; host projections never force key file reads.
  pkgs = {
    writeText = name: text: "/stub/${name}";
    writeShellScript = name: text: "/stub/${name}";
  };
  options = {
    services.tailscale = {
      enable = lib.mkOption { type = lib.types.bool; default = false; };
      extraUpFlags = lib.mkOption { type = lib.types.listOf lib.types.str; default = [ ]; };
      extraSetFlags = lib.mkOption { type = lib.types.listOf lib.types.str; default = [ ]; };
    };
    services.openssh = lib.mkOption { type = lib.types.attrs; default = { }; };
    launchd.daemons = lib.mkOption { type = lib.types.attrs; default = { }; };
    sops.secrets = lib.mkOption { type = lib.types.attrs; default = { }; };
  };
  evaluate = hostSystem: extra: (lib.evalModules {
    specialArgs = { inherit hostSystem pkgs; };
    modules = [ { inherit options; } tailscaleModule extra ];
  }).config;
  linux = evaluate "x86_64-linux" { };
  operator = evaluate "x86_64-linux" {
    services.tailscale.extraSetFlags = [ "--operator=bdsqqq" ];
  };
  hostFlags = path:
    let
      host = import path {
        inherit lib pkgs;
        config.sops.secrets.tailscale_auth_key.path = "/stub/auth-key";
        inputs = { };
        modulesPath = "";
      };
    in lib.filterAttrs (name: _: builtins.elem name [ "extraUpFlags" "extraSetFlags" ]) host.services.tailscale;
  relay = evaluate "x86_64-linux" {
    services.tailscale = hostFlags ../../hosts/htz-relay/default.nix;
  };
  lab = evaluate "x86_64-linux" {
    services.tailscale = hostFlags ../../hosts/htz-xfs-lab/default.nix;
  };
  darwin = evaluate "aarch64-darwin" { };
  sshFlags = flags: builtins.filter (lib.hasPrefix "--ssh") flags;
  vpnOnly = config:
    builtins.all (flags: flags != [ ] && builtins.all (flag: flag == "--ssh=false") flags) [
      (sshFlags config.services.tailscale.extraUpFlags)
      (sshFlags config.services.tailscale.extraSetFlags)
    ];
in
assert linux.services.tailscale.enable;
assert linux.services.tailscale.extraUpFlags == [ "--ssh=false" ];
assert linux.services.tailscale.extraSetFlags == [ "--ssh=false" ];
assert lib.sort builtins.lessThan operator.services.tailscale.extraSetFlags == [ "--operator=bdsqqq" "--ssh=false" ];
assert builtins.all vpnOnly [ linux operator relay lab ];
assert builtins.elem "--operator=bdsqqq" relay.services.tailscale.extraSetFlags;
assert darwin.services.tailscale == { enable = false; extraUpFlags = [ ]; extraSetFlags = [ ]; };
assert darwin.services.openssh == {
  enable = true;
  extraConfig = ''
    PermitRootLogin no
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowUsers bdsqqq@100.64.0.0/10 bdsqqq@fd7a:115c:a1e0::/48
  '';
};
assert darwin.launchd.daemons.tailnet-ssh-firewall.command == "/stub/load-tailnet-ssh-firewall";
true
