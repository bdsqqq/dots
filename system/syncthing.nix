{ lib, pkgs, hostSystem ? null, ... }:
let
  system = hostSystem;
  isLinux = lib.hasInfix "linux" system;
  isDarwin = lib.hasInfix "darwin" system;
  syncthing = import ../modules/syncthing.nix { inherit lib; };
  stignore = pkgs.writeText "commonplace-stignore"
    (syncthing.mkStignore (builtins.readFile ../config/ignore-common));
  userSyncthingConfig = {
    home-manager.users.bdsqqq = { lib, config, ... }: {
      home.activation.commonplaceStignore =
        lib.hm.dag.entryAfter [ "writeBoundary" ] ''
          mkdir -p "${config.home.homeDirectory}/commonplace"
          rm -f "${config.home.homeDirectory}/commonplace/.stignore"
          install -m 0644 ${stignore} "${config.home.homeDirectory}/commonplace/.stignore"
        '';
    };
  };
in if isLinux then lib.recursiveUpdate userSyncthingConfig {
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
  userSyncthingConfig // {
    # darwin: syncthing managed entirely by home-manager's services.syncthing
    # (creates launchd agents for both daemon and config init)
  }
else
  { }
