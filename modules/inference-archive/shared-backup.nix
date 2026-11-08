{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.inferenceArchive.sharedBackup;
  home = config.home-manager.users.${config.my.primaryUser}.home.homeDirectory;
  live = "${config.my.paths.commonplace}/01_files/nix/modules/inference-archive";
  repository = (builtins.fromJSON (builtins.readFile ../backup/ssd-01/drive.json)).repository;
  runtimePath = lib.types.addCheck lib.types.str (
    path: lib.hasPrefix "/" path && path != "/" && !lib.hasPrefix "/nix/store/" path
  );
  state = "${home}/.local/state/inference-shared-backup";
  configuration = pkgs.writeText "inference-shared-backup.json" (
    builtins.toJSON {
      inherit (cfg)
        archiveRoot
        passwordFile
        sshKeyPath
        knownHostsPath
        ;
      inherit repository;
      stateDirectory = state;
      resticPath = "${pkgs.restic}/bin/restic";
      sshPath = "${pkgs.openssh}/bin/ssh";
    }
  );
  runner = pkgs.writeShellScriptBin "inference-shared-backup" ''
    # Source edits remain native; published updates change the unit's ExecStart.
    # source: ${builtins.hashFile "sha256" ./shared-backup.ts}
    umask 077
    ${pkgs.coreutils}/bin/install -d -m 0700 ${lib.escapeShellArg state}
    exec ${pkgs.util-linux}/bin/flock --nonblock ${lib.escapeShellArg "${state}/backup.lock"} \
      ${pkgs.nodejs_24}/bin/node ${lib.escapeShellArg "${live}/shared-backup.ts"} ${configuration}
  '';
in
{
  options.my.inferenceArchive.sharedBackup = {
    enable = lib.mkEnableOption "independent keep-all backups of the shared raw inference collector";
    archiveRoot = lib.mkOption {
      type = runtimePath;
      default = "${home}/.local/share/inference-archive";
    };
    passwordFile = lib.mkOption {
      type = runtimePath;
      default = "${home}/.config/inference-shared-backup/password";
      description = "Existing repository password, provisioned privately outside Nix/sops.";
    };
    sshKeyPath = lib.mkOption {
      type = runtimePath;
      default = "${home}/.config/inference-shared-backup/id_ed25519";
    };
    knownHostsPath = lib.mkOption {
      type = runtimePath;
      default = "${home}/.config/inference-shared-backup/known_hosts";
    };
    intervalHours = lib.mkOption {
      type = lib.types.ints.between 1 24;
      default = 6;
    };
    package = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      default = runner;
      internal = true;
    };
    configuration = lib.mkOption {
      type = lib.types.path;
      readOnly = true;
      default = configuration;
      internal = true;
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = pkgs.stdenv.hostPlatform.isLinux;
        message = "shared inference archive backup runs on the Linux collector";
      }
    ];
    home-manager.users.${config.my.primaryUser} = { lib, ... }: {
      home.packages = [ runner ];
      systemd.user.services.inference-shared-backup = {
        Unit.Description = "Keep-all encrypted backup of shared raw inference journals";
        Service = {
          Type = "oneshot";
          ExecStart = "${runner}/bin/inference-shared-backup";
          UMask = "0077";
          TimeoutStartSec = "2h 2min";
          NoNewPrivileges = true;
          PrivateTmp = true;
          ProtectSystem = "strict";
          ReadWritePaths = [ state ];
          # Capture has no dependency on this unit or repository availability.
          StandardOutput = "journal";
          StandardError = "journal";
        };
      };
      systemd.user.timers.inference-shared-backup = {
        Unit.Description = "Periodic shared raw inference backup (catch up after downtime)";
        Timer = {
          OnCalendar = "*-*-* 00/${toString cfg.intervalHours}:00:00";
          Persistent = true;
          RandomizedDelaySec = "5min";
          Unit = "inference-shared-backup.service";
        };
        Install.WantedBy = [ "timers.target" ];
      };
      # Create only the private directory skeleton, never edit producer journals.
      home.activation.inferenceSharedBackupDirectories = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        $DRY_RUN_CMD ${pkgs.coreutils}/bin/install -d -m 0700 \
          ${lib.escapeShellArgs (
            [
              state
              cfg.archiveRoot
            ]
            ++ map (name: "${cfg.archiveRoot}/${name}") [
              "journal"
              "origins"
              "receipts"
            ]
          )}
      '';
    };
  };
}
