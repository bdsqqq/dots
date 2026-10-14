{ root, guid, port, probeSystemd ? false, omitActivationTools ? false
, pkgs ? import (builtins.getFlake ("git+file://" + toString ../..)).inputs.nixpkgs {
    system = builtins.currentSystem;
  }
}:
let
  inherit (pkgs) lib;
  evaluated = (lib.evalModules {
    specialArgs = {
      inherit pkgs;
      # Exercise the generated systemd control scripts on a native test backend;
      # this does not pretend to build or install Linux units on Darwin.
      hostSystem = if probeSystemd then "aarch64-linux" else pkgs.stdenv.hostPlatform.system;
    };
    modules = [
      ./default.nix
      {
        options = {
          assertions = lib.mkOption { type = lib.types.listOf lib.types.anything; default = [ ]; };
          home-manager = lib.mkOption { type = lib.types.attrs; default = { }; };
          networking = lib.mkOption { type = lib.types.attrs; };
        };
        config = {
          networking.localHostName = "launcher-fixture";
          my.backup = {
            homeDirectory = "${root}/home";
            configDirectory = "${root}/config";
            dataDirectory = "${root}/data";
            bindAddress = "127.0.0.1:${toString port}";
            defaultRepository = "local";
            repositories.local = {
              uri = "${root}/repository";
              inherit guid;
              passwordFile = "${root}/password";
              autoInitialize = false;
              autoUnlock = false;
              checkPolicy.schedule.disabled = true;
              prunePolicy.schedule.disabled = true;
            };
            plans.fixture = {
              paths = [ "${root}/source" ];
              schedule.disabled = true;
            };
          };
        };
      }
    ];
  }).config;
  home = (builtins.getFlake ("git+file://" + toString ../..)).inputs.home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      evaluated.home-manager.users.bdsqqq
      {
        home.username = "backup-fixture";
        home.homeDirectory = "${root}/home";
        home.stateVersion = "24.11";
        systemd.user.systemctlPath = "${root}/bin/systemctl";
        home.extraActivationPath = lib.mkIf omitActivationTools (lib.mkForce [ ]);
        launchd.agents.backup-health = lib.mkIf pkgs.stdenv.isDarwin {
          domain = "user";
          config.Label = "org.nix-community.home.backup-fixture";
        };
      }
    ];
  };
  environment = pkgs.runCommand "backup-fixture-environment" { } ''
    ${pkgs.gnused}/bin/sed -n '/^export PATH=/p' ${home.activationPackage}/activate > "$out"
    test -s "$out"
  '';
  prelude = ''
    # Use the consumer's actual PATH and check dependencies BEFORE substituting
    # service mocks. Otherwise the fixture can hide undeclared activation tools.
    source ${environment}
    ${lib.optionalString (!probeSystemd && pkgs.stdenv.isDarwin) ''
      command -v launchctl >/dev/null
      command -v sw_vers >/dev/null
      command -v awk >/dev/null
    ''}
    export PATH=${lib.escapeShellArg "${root}/bin"}:"$PATH"
  '';
  activation = pkgs.writeShellApplication {
    name = "backup-fixture-activation";
    text = prelude + home.config.home.activation.backupConfig.data;
    excludeShellChecks = [ "SC1091" ]; # generated consumer environment
  };
  start = pkgs.writeShellApplication {
    name = "backup-fixture-start";
    text = prelude + home.config.home.activation.backupStart.data;
    excludeShellChecks = [ "SC1091" ];
  };
in
assert lib.hasPrefix "/" root && !(lib.hasPrefix "/nix/store/" root);
assert builtins.match "[0-9a-f]{64}" guid != null;
assert builtins.isInt port && port > 0 && port < 65536;
assert builtins.all (item: item.assertion) evaluated.assertions;
assert builtins.all (item: item.assertion) home.config.assertions;
assert builtins.elem "setupLaunchAgents" home.config.home.activation.backupConfig.before;
assert builtins.elem "linkGeneration" home.config.home.activation.backupConfig.before;
assert builtins.elem "writeBoundary" home.config.home.activation.backupConfig.after;
pkgs.runCommand "backup-launcher-fixture" { } ''
  mkdir -p "$out/bin"
  ln -s ${evaluated.my.backup.package}/bin/backup-health-server "$out/bin/"
  ln -s ${activation}/bin/backup-fixture-activation "$out/bin/"
  ${lib.optionalString (probeSystemd || pkgs.stdenv.isLinux) ''
    ln -s ${start}/bin/backup-fixture-start "$out/bin/"
  ''}
  ln -s ${home.activationPackage} "$out/home-activation"
''
