{ lib, config, pkgs, hostSystem, ... }:

let
  cfg = config.system.autoUpgrade;
  statusDir = cfg.supervision.stateDir;
  source = pkgs.runCommand "host-upgrade-source" { } ''
    mkdir -p "$out/nix" "$out/service-events"
    cp ${./host-upgrade.ts} "$out/nix/host-upgrade.ts"
    cp ${./upgrade-status.ts} "$out/nix/upgrade-status.ts"
    cp ${../service-events/events.ts} "$out/service-events/events.ts"
  '';
  runner = pkgs.writeShellScriptBin "host-upgrade" ''
    exec ${pkgs.nodejs_latest}/bin/node --experimental-strip-types ${source}/nix/host-upgrade.ts "$@"
  '';
  dependencyCheck = pkgs.writeShellScript "host-upgrade-dependencies" ''
    ${import ../homebrew/dependency-check.nix { inherit lib pkgs; homebrew = config.homebrew; }}
  '';
  dependencyRepair = pkgs.writeShellScript "host-upgrade-dependency-repair" ''
    # The native user must be able to traverse cwd after sudo drops root.
    cd /
    export HOMEBREW_NO_AUTO_UPDATE=1
    ${config.homebrew.onActivation.brewBundleCmd { onlyCheck = false; }}
  '';
  runtime = pkgs.writeText "host-upgrade.json" (builtins.toJSON ({
    host = config.networking.localHostName;
    flake = "github:bdsqqq/dots";
    stateDir = statusDir;
    operation = cfg.operation;
    nixCommand = [ "${config.nix.package}/bin/nix" ];
    rebuildCommand = [ "/nix/var/nix/profiles/system/sw/bin/darwin-rebuild" ];
    revisionCommand = [ "/nix/var/nix/profiles/system/sw/bin/darwin-version" "--configuration-revision" ];
    inherit (cfg.supervision) buildTimeoutMs activationWarnAfterMs;
    retryBaseMs = 5 * 60 * 1000;
    retryMaxMs = 6 * 60 * 60 * 1000;
  } // lib.optionalAttrs (config.homebrew.enable or false) {
    dependencyCheckCommand = [ "${dependencyCheck}" ];
    dependencyRepairCommand = [ "${dependencyRepair}" ];
  }));
in

# Platform selection must use specialArgs, not pkgs (which depends on config).
if lib.hasSuffix "-darwin" hostSystem then {
  # NixOS already owns this namespace; only define the Darwin counterpart.
  options.system.autoUpgrade = {
    enable = lib.mkEnableOption "hourly upgrades from the published dots flake" // {
      default = true;
    };
    supervision = {
      enable = lib.mkEnableOption "bounded build attempts and externally observable upgrade convergence";
      stateDir = lib.mkOption {
        type = lib.types.str;
        default = "/var/db/host-upgrade";
        description = "Root-owned state containing only safe revision and attempt metadata.";
      };
      buildTimeoutMs = lib.mkOption {
        type = lib.types.ints.positive;
        default = 90 * 60 * 1000;
        description = "Build deadline; only the attempt's own process group is cancelled.";
      };
      activationWarnAfterMs = lib.mkOption {
        type = lib.types.ints.positive;
        default = 30 * 60 * 1000;
        description = "Overdue activation threshold for observers; never a mid-activation kill timer.";
      };
    };
    operation = lib.mkOption {
      type = lib.types.enum [ "build" "switch" ];
      default = "switch";
      description = "Build only, or build and activate the published configuration. Neither operation waits for idle.";
    };
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [ {
    launchd.daemons.darwin-upgrade.serviceConfig = {
      UserName = "root";
      # The profile selects the locked tool without changing this plist on
      # tool upgrades, which would unload the updater during its own activation.
      ProgramArguments = if cfg.supervision.enable then [
        "/nix/var/nix/profiles/system/sw/bin/host-upgrade" "run" "--config" "/etc/host-upgrade.json"
      ] else [
        "/nix/var/nix/profiles/system/sw/bin/darwin-rebuild"
        cfg.operation
        "--flake"
        "github:bdsqqq/dots#${config.networking.localHostName}"
        "--refresh"
        "--no-write-lock-file"
      ];
      EnvironmentVariables.HOME = "/var/root";
      # Build-only creates a result link here, never in a user's checkout.
      WorkingDirectory = "/var/root";
      # Supervised ticks only inspect/retry when due; unchanged revisions do not reactivate.
      StartCalendarInterval = if cfg.supervision.enable
        then map (n: { Minute = n * 5; }) (lib.range 0 11)
        else [ { Minute = 0; } ];
      StandardOutPath = "/var/log/darwin-upgrade.log";
      StandardErrorPath = "/var/log/darwin-upgrade.log";
    };
  } (lib.mkIf cfg.supervision.enable {
    launchd.daemons.darwin-upgrade.serviceConfig.RunAtLoad = false;
    environment.systemPackages = [ runner ];
    environment.etc."host-upgrade.json".source = runtime;
    system.activationScripts.postActivation.text = lib.mkAfter ''
      ${runner}/bin/host-upgrade init --config /etc/host-upgrade.json
    '';
  }) ]);
} else {
  system.autoUpgrade = {
    enable = lib.mkDefault true;
    flake = lib.mkDefault "github:bdsqqq/dots#${config.networking.hostName}";
    dates = lib.mkDefault "hourly";
    allowReboot = lib.mkDefault false;
    flags = [ "--refresh" ];
  };
}
