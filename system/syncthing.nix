{ lib, pkgs, config, hostSystem ? null, ... }:
let
  system = hostSystem;
  isLinux = lib.hasInfix "linux" system;
  isDarwin = lib.hasInfix "darwin" system;
  syncthing = import ../modules/syncthing.nix { inherit lib; };
  stignore = pkgs.writeText "commonplace-stignore"
    (syncthing.mkStignore (builtins.readFile ../config/ignore-common));

  linuxCommonplacePath = lib.attrByPath [
    "services"
    "syncthing"
    "settings"
    "folders"
    "commonplace"
    "path"
  ] "/home/bdsqqq/commonplace"
    config;

  linuxStignoreConfig = {
    systemd.tmpfiles.rules = [
      "d ${linuxCommonplacePath} 0700 bdsqqq users -"
      "C+ ${linuxCommonplacePath}/.stignore 0644 bdsqqq users - ${stignore}"
    ];
  };

  darwinStignoreConfig = {
    home-manager.users.bdsqqq = { lib, config, ... }:
      let
        commonplacePath = lib.attrByPath [
          "services"
          "syncthing"
          "settings"
          "folders"
          "commonplace"
          "path"
        ] "${config.home.homeDirectory}/commonplace"
          config;
      in
      {
        home.activation.commonplaceStignore =
          lib.hm.dag.entryAfter [ "writeBoundary" ] ''
            mkdir -p ${lib.escapeShellArg commonplacePath}
            rm -f ${lib.escapeShellArg "${commonplacePath}/.stignore"}
            install -m 0644 ${stignore} ${lib.escapeShellArg "${commonplacePath}/.stignore"}
          '';
      };
  };
in if isLinux then lib.recursiveUpdate linuxStignoreConfig {
  # NixOS uses system service; declarative folder/device config in host files
  services.syncthing = {
    enable = true;
    user = "bdsqqq";
    dataDir = "/home/bdsqqq";
    configDir = "/home/bdsqqq/.config/syncthing";
    guiAddress = "0.0.0.0:8384";
  };

  networking.firewall.interfaces."tailscale0".allowedTCPPorts = [ 8384 22000 ];
  networking.firewall.interfaces."tailscale0".allowedUDPPorts = [ 22000 21027 ];
} else if isDarwin then
  darwinStignoreConfig // {
    # darwin: syncthing managed entirely by home-manager's services.syncthing
    # (creates launchd agents for both daemon and config init)
  }
else
  { }
