{ config, lib, ... }:
let
  cfg = config.my.inferenceArchive.backup;
  repository = (builtins.fromJSON (builtins.readFile ../backup/ssd-01/drive.json)).repository;
  runtimePath = lib.types.addCheck lib.types.str (
    path: lib.hasPrefix "/" path && path != "/" && !lib.hasPrefix "/nix/store/" path
  );
in
{
  # The caller imports ssd-01/repository.nix, NOT its removable-volume plan.
  options.my.inferenceArchive.backup = {
    enable = lib.mkEnableOption "keep-all inference journal backups";
    archiveRoot = lib.mkOption {
      type = runtimePath;
      default = "${
        config.home-manager.users.${config.my.primaryUser}.home.homeDirectory
      }/.local/share/inference-archive";
    };
    intervalHours = lib.mkOption {
      type = lib.types.ints.between 1 168;
      default = 6;
    };
  };
  config = lib.mkIf cfg.enable {
    my.backup.plans.inference-archive = {
      repository = repository.id;
      # Never widen this to archiveRoot: indexer credentials/state are not backups.
      paths = [
        "${cfg.archiveRoot}/journal"
        "${cfg.archiveRoot}/receipts"
      ];
      schedule = {
        maxFrequencyHours = cfg.intervalHours;
        clock = "CLOCK_LAST_RUN_TIME";
      };
      retention.policyKeepAll = true;
      requirePaths = true;
      skipIfUnchanged = true;
      backupFlags = [ "--tag inference-archive" ];
      # Independent of the repository's removable-drive plan and its hooks.
      hooks = [ ];
      excludes = [ ];
    };
    assertions = [
      {
        assertion = config.my.backup.repositories.${repository.id}.autoInitialize == false;
        message = "inference archive backup must reuse the initialized ssd-01 repository";
      }
    ];
  };
}
