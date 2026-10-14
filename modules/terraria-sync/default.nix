{ config, lib, hostSystem, ... }:
let
  cfg = config.my.terrariaSync;
  isDarwin = lib.hasInfix "darwin" hostSystem;
  syncthing = import ../syncthing/lib.nix { inherit lib; };
  # hosts may narrow trust (e.g. disable mbp-m2's introducer flag on the mini).
  devices = lib.mapAttrs (_: value: lib.mkDefault value) (syncthing.devicesFor cfg.devices);
  folders = {
    terraria-players = syncthing.folderForPath "terraria-players" "${cfg.saveRoot}/Players" cfg.devices folderOptions;
    terraria-worlds = syncthing.folderForPath "terraria-worlds" "${cfg.saveRoot}/Worlds" cfg.devices folderOptions;
  };
  folderOptions = {
    type = cfg.type;
    rescanIntervalS = 60;
    fsWatcherDelayS = 10;
    # the archive sees every inbound change, including saves made on the mac.
    # mac-side versioning alone would not preserve its own local overwrites.
    versioning = {
      type = "staggered";
      params = {
        maxAge = "31536000";
        cleanInterval = "3600";
      };
    };
  };
in
{
  options.my.terrariaSync = {
    enable = lib.mkEnableOption "native terraria save syncing";
    saveRoot = lib.mkOption {
      type = lib.types.str;
      default =
        if isDarwin then
          "/Users/bdsqqq/Library/Application Support/Terraria"
        else
          "/home/bdsqqq/.local/share/Terraria";
      description = "real save directory, or an archive directory on a non-playing host";
    };
    devices = lib.mkOption {
      type = lib.types.listOf (lib.types.enum (builtins.attrNames syncthing.devices));
      default = [ ];
      description = "peers enrolled in both save folders; omit the current host";
    };
    type = lib.mkOption {
      type = lib.types.enum [ "sendreceive" "receiveonly" ];
      default = "sendreceive";
      description = "receiveonly isolates an archive host's accidental edits";
    };
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      assertions = [
        {
          assertion = cfg.devices != [ ];
          message = "terraria-sync needs at least one peer";
        }
        {
          assertion = lib.hasPrefix "/" cfg.saveRoot;
          message = "terraria-sync saveRoot must be absolute";
        }
      ];
    }
    (if isDarwin then {
      home-manager.users.bdsqqq.services.syncthing = {
        settings = {
          inherit devices folders;
        };
      };
    } else {
      services.syncthing.settings = {
        inherit devices folders;
      };
    })
  ]);
}
