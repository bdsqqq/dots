{ lib, config, hostSystem, ... }:

# Platform selection must use specialArgs, not pkgs (which depends on config).
if lib.hasSuffix "-darwin" hostSystem then {
  # NixOS already owns this namespace; only define the Darwin counterpart.
  options.system.autoUpgrade = {
    enable = lib.mkEnableOption "hourly upgrades from the published dots flake" // {
      default = true;
    };
    operation = lib.mkOption {
      type = lib.types.enum [ "build" "switch" ];
      default = "switch";
      description = "Build only, or build and activate the published configuration. Neither operation waits for idle.";
    };
  };

  config = lib.mkIf config.system.autoUpgrade.enable {
    launchd.daemons.darwin-upgrade.serviceConfig = {
      UserName = "root";
      # The profile selects the locked tool without changing this plist on
      # tool upgrades, which would unload the updater during its own activation.
      ProgramArguments = [
        "/nix/var/nix/profiles/system/sw/bin/darwin-rebuild"
        config.system.autoUpgrade.operation
        "--flake"
        "github:bdsqqq/dots#${config.networking.localHostName}"
        "--refresh"
        "--no-write-lock-file"
      ];
      EnvironmentVariables.HOME = "/var/root";
      # Build-only creates a result link here, never in a user's checkout.
      WorkingDirectory = "/var/root";
      StartCalendarInterval = [ { Minute = 0; } ];
      StandardOutPath = "/var/log/darwin-upgrade.log";
      StandardErrorPath = "/var/log/darwin-upgrade.log";
    };
  };
} else {
  system.autoUpgrade = {
    enable = lib.mkDefault true;
    flake = lib.mkDefault "github:bdsqqq/dots#${config.networking.hostName}";
    dates = lib.mkDefault "hourly";
    allowReboot = lib.mkDefault false;
    flags = [ "--refresh" ];
  };
}
