{ config, lib, pkgs, ... }:

with lib;

let
  cfg = config.programs.nushell;
in

{
  options = {
    programs.nushell = {
      enable = mkEnableOption "nushell";
    };
  };

  config = mkIf cfg.enable {
    # Add nushell to system packages
    environment.systemPackages = [ pkgs.nushell ];

    # Add nushell to /etc/shells so it can be used as a login shell
    environment.shells = [ pkgs.nushell ];

    # Create system-wide nushell configuration directory
    environment.etc."nushell/config.nu" = {
      text = ''
        # System-wide nushell configuration
        # This ensures proper environment loading when nushell is the default shell
        
        # Load nix-darwin environment
        if ("/etc/bashrc" | path exists) {
          # Parse bash environment and load into nushell
          let bash_env = (^bash -c "source /etc/bashrc && env" | lines | each { |line| $line | parse "{key}={value}" } | flatten | where key != "" | reduce -f {} { |row, acc| $acc | upsert $row.key $row.value })
          load-env $bash_env
        }
        
        # Ensure nix-darwin paths are available
        if ("/etc/profiles/per-user" | path exists) {
          let user_profile = $"/etc/profiles/per-user/($env.USER)/bin"
          if ($user_profile | path exists) {
            $env.PATH = ($env.PATH | split row (char esep) | prepend $user_profile)
          }
        }
      '';
    };

    # Set up proper shell initialization for login shells
    environment.etc."nushell/env.nu" = {
      text = ''
        # System-wide nushell environment configuration
        # This file is sourced for login shells
        
        # Source system-wide bash profile to get nix-darwin environment
        if ("/etc/profile" | path exists) {
          let system_env = (^bash -c "source /etc/profile && env" | lines | each { |line| $line | parse "{key}={value}" } | flatten | where key != "" | reduce -f {} { |row, acc| $acc | upsert $row.key $row.value })
          load-env $system_env
        }
      '';
    };
  };
} 