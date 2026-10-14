# evaluate with the flake's nixpkgs lib; these fixtures do not start services.
{ lib }:
let
  evaluate = hostSystem: settings:
    (lib.evalModules {
      specialArgs = { inherit hostSystem; };
      modules = [
        ./default.nix
        {
          options = {
            assertions = lib.mkOption { type = lib.types.listOf lib.types.anything; default = [ ]; };
            services = lib.mkOption { type = lib.types.attrs; default = { }; };
            home-manager = lib.mkOption { type = lib.types.attrs; default = { }; };
          };
          config.my.terrariaSync = settings;
        }
      ];
    }).config;
  mac = evaluate "aarch64-darwin" {
    enable = true;
    devices = [ "ipd" "mmn-m4" ];
  };
  archive = evaluate "aarch64-darwin" {
    enable = true;
    saveRoot = "/archive/terraria";
    devices = [ "mbp-m2" "ipd" ];
    type = "receiveonly";
  };
  linux = evaluate "x86_64-linux" {
    enable = true;
    devices = [ "ipd" ];
  };
  disabled = evaluate "aarch64-darwin" { };
  emptyPeers = evaluate "aarch64-darwin" { enable = true; };
  relativeRoot = evaluate "aarch64-darwin" {
    enable = true;
    devices = [ "ipd" ];
    saveRoot = "relative";
  };
  # Nested options exercise per-device priorities; opaque attrs would not
  # protect the mini's explicit trust override against module defaults.
  trust = (lib.evalModules {
    specialArgs.hostSystem = "aarch64-darwin";
    modules = [
      ./default.nix
      {
        options = {
          assertions = lib.mkOption { type = lib.types.listOf lib.types.anything; default = [ ]; };
          home-manager.users = lib.mkOption {
            type = lib.types.attrsOf (lib.types.submodule {
              options.services.syncthing.settings = lib.mkOption {
                type = lib.types.submodule {
                  options = {
                    devices = lib.mkOption {
                      type = lib.types.attrsOf (lib.types.submodule {
                        freeformType = lib.types.attrsOf lib.types.anything;
                        options.introducer = lib.mkOption { type = lib.types.bool; default = false; };
                      });
                    };
                    folders = lib.mkOption { type = lib.types.attrs; };
                  };
                };
              };
            });
          };
        };
        config = {
          my.terrariaSync = { enable = true; devices = [ "mbp-m2" "ipd" ]; type = "receiveonly"; };
          home-manager.users.bdsqqq.services.syncthing.settings.devices.mbp-m2.introducer = false;
        };
      }
    ];
  }).config;
  macFolders = mac.home-manager.users.bdsqqq.services.syncthing.settings.folders;
  archiveFolders = archive.home-manager.users.bdsqqq.services.syncthing.settings.folders;
  linuxFolders = linux.services.syncthing.settings.folders;
  valid = cfg: builtins.all (item: item.assertion) cfg.assertions;
in
assert valid mac && valid archive && valid linux;
assert !valid emptyPeers && !valid relativeRoot;
assert disabled.home-manager == { } && disabled.services == { };
assert macFolders.terraria-players.path == "/Users/bdsqqq/Library/Application Support/Terraria/Players";
assert macFolders.terraria-worlds.id == "terraria-worlds";
assert macFolders.terraria-players.id == "terraria-players";
assert macFolders.terraria-players.devices == [ "ipd" "mmn-m4" ];
assert macFolders.terraria-worlds.type == "sendreceive";
assert archiveFolders.terraria-worlds.type == "receiveonly";
assert archiveFolders.terraria-worlds.path == "/archive/terraria/Worlds";
assert archiveFolders.terraria-worlds.versioning.type == "staggered";
assert archiveFolders.terraria-worlds.versioning.params.maxAge == "31536000";
assert linuxFolders.terraria-worlds.path == "/home/bdsqqq/.local/share/Terraria/Worlds";
assert linuxFolders.terraria-worlds.devices == [ "ipd" ];
assert valid trust;
assert !trust.home-manager.users.bdsqqq.services.syncthing.settings.devices.mbp-m2.introducer;
true
