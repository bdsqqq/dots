{ config, lib, pkgs, hostSystem, ... }:
let
  cfg = config.my.backup;
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
  absolutePath = lib.types.addCheck lib.types.str (lib.hasPrefix "/");
  nativeSettings = lib.types.attrsOf lib.types.anything;
  exclusiveSchedule = value: builtins.length (builtins.filter
    (name: (value.${name} or null) != null)
    [ "disabled" "cron" "maxFrequencyDays" "maxFrequencyHours" ]) <= 1;
  # native schedules select one mode; null marks fields omitted from JSON.
  scheduleType = lib.types.addCheck (lib.types.submodule ({ config, ... }: {
    options = {
      disabled = lib.mkOption {
        type = lib.types.nullOr (lib.types.enum [ true ]);
        default = null;
        description = "disable automatic runs; native backrest requires true";
      };
      cron = lib.mkOption {
        type = lib.types.nullOr (lib.types.addCheck lib.types.str (value: value != ""));
        default = null;
        description = "native cron expression in the daemon timezone; syntax checked by backrest during the package build";
      };
      maxFrequencyDays = lib.mkOption { type = lib.types.nullOr (lib.types.ints.between 1 2147483647); default = null; };
      maxFrequencyHours = lib.mkOption {
        type = lib.types.nullOr (lib.types.ints.between 1 2147483647);
        # another explicit mode replaces the interval, not the independent clock.
        default = if config.cron != null || config.disabled != null || config.maxFrequencyDays != null then null else 24;
      };
      clock = lib.mkOption {
        type = lib.types.enum [ "CLOCK_DEFAULT" "CLOCK_LOCAL" "CLOCK_UTC" "CLOCK_LAST_RUN_TIME" ];
        default = "CLOCK_LAST_RUN_TIME";
        description = "native scheduling anchor; LAST_RUN_TIME uses the last completed attempt, not the last successful snapshot";
      };
    };
  })) exclusiveSchedule;
  # recheck after module merging: separate contributions can each be valid
  # while jointly selecting conflicting oneof fields.
  mkSchedule = value:
    if exclusiveSchedule value then lib.filterAttrs (_: item: item != null) value
    else throw "backrest Schedule accepts at most one of cron, disabled, maxFrequencyDays, maxFrequencyHours";
  # native validation catches config rules not expressed by these nix types.
  # test additions leave the daemon implementation unchanged.
  backrest = pkgs.backrest.overrideAttrs (old: {
    postPatch = (old.postPatch or "") + ''
      cp ${./native_schedule_test.go} internal/protoutil/native_schedule_test.go
      cp ${./schedule_history_test.go} internal/orchestrator/tasks/schedule_history_test.go
    '';
    postCheck = (old.postCheck or "") + ''
      NIX_BACKUP_CONFIG=${settings} go test ./internal/protoutil -run TestNixNative -count=1
      TZ=UTC go test ./internal/orchestrator/tasks -run TestNixScheduleHistory -count=1
    '';
  });
  pathGuard = paths: {
    conditions = [ "CONDITION_SNAPSHOT_START" ];
    onError = "ON_ERROR_CANCEL";
    actionCommand.command = ''
      #!/bin/sh
      set -eu
      ${lib.concatMapStringsSep "\n" (path: ''
        if [ ! -e ${lib.escapeShellArg path} ]; then
          printf '%s\n' ${lib.escapeShellArg "backup source missing: ${path}"} >&2
          exit 1
        fi
      '') paths}
    '';
  };
  generated = {
    repos = lib.mapAttrsToList (id: repo: {
      inherit id;
      inherit (repo) uri guid flags autoInitialize autoUnlock checkPolicy prunePolicy hooks;
      password = "";
      env = repo.env
        ++ lib.optional (repo.passwordCommand != null) "RESTIC_PASSWORD_COMMAND=${repo.passwordCommand}"
        ++ lib.optional (repo.passwordFile != null) "RESTIC_PASSWORD_FILE=${repo.passwordFile}";
    }) cfg.repositories;
    plans = lib.mapAttrsToList (id: plan: {
      inherit id;
      repo = plan.repository;
      inherit (plan) paths excludes retention skipIfUnchanged;
      iexcludes = [ ];
      schedule = mkSchedule plan.schedule;
      hooks = lib.optional plan.requirePaths (pathGuard plan.paths) ++ plan.hooks;
      backup_flags = [ "--host ${config.networking.localHostName or config.networking.hostName}" ]
        ++ plan.backupFlags;
    }) cfg.plans;
  };
  settings = pkgs.writeText "backrest-config.json" (builtins.toJSON (generated // {
    modno = 1;
    version = 6;
    instance = config.networking.localHostName or config.networking.hostName;
    auth = { disabled = true; users = [ ]; };
  }));
  server = pkgs.writeShellApplication {
    name = "backup-health-server";
    runtimeInputs = [ backrest pkgs.restic pkgs.openssh pkgs.sops pkgs.coreutils ];
    text = ''
      mkdir -p ${lib.escapeShellArg cfg.configDirectory} ${lib.escapeShellArg cfg.dataDirectory}
      temporary="$(mktemp ${lib.escapeShellArg "${cfg.configDirectory}/.config.json.XXXXXX"})"
      trap 'rm -f "$temporary"' EXIT
      # nix owns config at startup; rename avoids exposing a partial copy.
      install -m 0600 ${settings} "$temporary"
      mv -f "$temporary" ${lib.escapeShellArg "${cfg.configDirectory}/config.json"}
      exec backrest \
        -bind-address ${lib.escapeShellArg cfg.bindAddress} \
        -config-file ${lib.escapeShellArg "${cfg.configDirectory}/config.json"} \
        -data-dir ${lib.escapeShellArg cfg.dataDirectory} \
        -restic-cmd ${pkgs.restic}/bin/restic
    '';
  };
in
{
  options.my.backup = {
    enable = lib.mkEnableOption "declarative backrest backup plans" // {
      default = cfg.plans != { };
    };
    homeDirectory = lib.mkOption {
      type = absolutePath;
      default = config.home-manager.users.bdsqqq.home.homeDirectory;
      description = "home of the user running backrest";
    };
    configDirectory = lib.mkOption {
      type = absolutePath;
      default = "${cfg.homeDirectory}/.config/backrest";
      description = "writable backrest configuration, replaced from nix on each startup";
    };
    dataDirectory = lib.mkOption {
      type = absolutePath;
      default = "${cfg.homeDirectory}/.local/share/backrest";
      description = "backrest operation history";
    };
    bindAddress = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1:9898";
      description = "backrest listener; generated config disables auth, so keep this on loopback";
    };
    defaultRepository = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "repository used when a plan omits its destination";
    };
    repositories = lib.mkOption {
      default = { };
      type = lib.types.attrsOf (lib.types.submodule {
        options = {
          uri = lib.mkOption { type = lib.types.str; description = "restic repository uri"; };
          guid = lib.mkOption {
            type = lib.types.str;
            default = "";
            description = "restic repository id; required unless autoInitialize is enabled";
          };
          passwordFile = lib.mkOption {
            type = lib.types.nullOr absolutePath;
            default = null;
            description = "runtime password file, never a nix store path";
          };
          passwordCommand = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "runtime command that reads the repository password";
          };
          env = lib.mkOption { type = lib.types.listOf lib.types.str; default = [ ]; };
          flags = lib.mkOption { type = lib.types.listOf lib.types.str; default = [ ]; };
          hooks = lib.mkOption { type = lib.types.listOf nativeSettings; default = [ ]; };
          autoInitialize = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = "explicit opt-in to initializing a repository";
          };
          autoUnlock = lib.mkOption { type = lib.types.bool; default = true; };
          prunePolicy = lib.mkOption {
            type = nativeSettings;
            default = { schedule.disabled = true; };
            description = "native backrest prune policy; disabled by default";
          };
          checkPolicy = lib.mkOption {
            type = nativeSettings;
            default = { schedule.maxFrequencyDays = 7; readDataSubsetPercent = 5; };
            description = "native backrest repository verification policy";
          };
        };
      });
    };
    plans = lib.mkOption {
      default = { };
      type = lib.types.attrsOf (lib.types.submodule {
        options = {
          paths = lib.mkOption {
            type = lib.types.coercedTo absolutePath (path: [ path ]) (lib.types.listOf absolutePath);
            description = "one absolute file/folder path or a list of paths";
          };
          repository = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = cfg.defaultRepository;
            description = "destination repository name; inherits the host default";
          };
          schedule = lib.mkOption {
            type = scheduleType;
            default = { };
            description = "native backrest schedule; partial overrides retain independent defaults";
          };
          retention = lib.mkOption {
            type = nativeSettings;
            default = { policyKeepAll = true; };
            description = "native backrest retention policy; keeps all snapshots by default";
          };
          excludes = lib.mkOption { type = lib.types.listOf lib.types.str; default = [ ]; };
          hooks = lib.mkOption { type = lib.types.listOf nativeSettings; default = [ ]; };
          backupFlags = lib.mkOption { type = lib.types.listOf lib.types.str; default = [ ]; };
          requirePaths = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "cancel rather than silently snapshot an incomplete set of source paths";
          };
          skipIfUnchanged = lib.mkOption { type = lib.types.bool; default = true; };
        };
      });
    };
    generated = lib.mkOption { type = nativeSettings; readOnly = true; internal = true; };
    package = lib.mkOption { type = lib.types.package; readOnly = true; internal = true; };
    backendPackage = lib.mkOption { type = lib.types.package; readOnly = true; internal = true; };
  };

  config = lib.mkIf cfg.enable {
    my.backup = { inherit generated; package = server; backendPackage = backrest; };
    assertions = [
      { assertion = isDarwin || isLinux; message = "my.backup supports darwin and linux"; }
      {
        assertion = lib.hasPrefix "127.0.0.1:" cfg.bindAddress;
        message = "my.backup requires a loopback listener; expose it through the authenticated tailnet service";
      }
    ] ++ lib.mapAttrsToList (name: repo: {
      assertion = (repo.passwordFile != null) != (repo.passwordCommand != null)
        && (repo.passwordFile == null || !lib.hasPrefix "/nix/store/" repo.passwordFile);
      message = "backup repository ${name}: choose exactly one runtime passwordFile or passwordCommand";
    }) cfg.repositories ++ lib.mapAttrsToList (name: repo: {
      assertion = (repo.guid != "") != repo.autoInitialize;
      message = "backup repository ${name}: choose exactly one of guid or autoInitialize";
    }) cfg.repositories ++ lib.mapAttrsToList (name: plan: {
      assertion = plan.paths != [ ] && plan.repository != null
        && builtins.hasAttr plan.repository cfg.repositories;
      message = "backup plan ${name}: needs nonempty paths and a declared repository";
    }) cfg.plans;

    home-manager.users.bdsqqq = { config, ... }: {
      home.packages = [ server ];
      launchd.agents.backup-health = lib.mkIf isDarwin {
        enable = true;
        config = {
          ProgramArguments = [ "${server}/bin/backup-health-server" ];
          RunAtLoad = true;
          KeepAlive = true;
          ThrottleInterval = 10;
          ProcessType = "Background";
          StandardOutPath = "${config.home.homeDirectory}/Library/Logs/backup-health.log";
          StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/backup-health.log";
        };
      };
      systemd.user.services.backup-health = lib.mkIf isLinux {
        Unit.Description = "backrest backup plans";
        Service = {
          ExecStart = "${server}/bin/backup-health-server";
          Restart = "on-failure";
          RestartSec = 10;
        };
        Install.WantedBy = [ "default.target" ];
      };
    };
  };
}
