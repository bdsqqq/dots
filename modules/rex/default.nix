{ config, lib, pkgs, inputs, hostSystem, headMode ? "graphical", ... }:
let
  isLinux = lib.hasInfix "linux" hostSystem;
  isDarwin = lib.hasInfix "darwin" hostSystem;
  bootstrap = inputs.rex.packages.${hostSystem}.rex;
  packages = import ./package.nix { inherit pkgs bootstrap; };
  # system services do not source the login-shell nix-ld environment.
  nativeEnvironment = {
    NIX_LD = "/run/current-system/sw/share/nix-ld/lib/ld.so";
    NIX_LD_LIBRARY_PATH = "/run/current-system/sw/share/nix-ld/lib";
  };
  repoConfig = "${config.my.paths.commonplace}/01_files/nix/modules/rex/config";
in
{
  imports = [ ./credential.nix ] ++ lib.optionals isLinux [
    inputs.rex.nixosModules.default
  ];

  config = lib.mkMerge [
    {
      # macs also evaluate the linux fleet (ssh config) and fetch this flake input.
      my.rex.credential.required = true;
      nix.settings.netrc-file = config.sops.secrets.rex_netrc.path;
    }
    (lib.optionalAttrs isLinux {
      services.rex.package = packages.runtime;
      environment.systemPackages = [ packages.updater ];
      # native/ui tarball replacements retain their upstream ELF interpreter.
      programs.nix-ld.enable = true;
      programs.nix-ld.libraries = [ pkgs.pam ];
      systemd.services.rex-login-server = {
        requires = [ "rex-install.service" ];
        after = [ "rex-install.service" ];
        environment = nativeEnvironment;
      };

      # seed only when absent. system activation must never restore an older binary.
      systemd.services.rex-install = {
        description = "Seed the native Rex installation if missing";
        serviceConfig = { Type = "oneshot"; RemainAfterExit = true; UMask = "0022"; };
        path = [ pkgs.systemd pkgs.gzip ];
        environment = nativeEnvironment;
        script = ''
          if [ ! -e /usr/local/bin/rex ] && [ ! -L /usr/local/bin/rex ]; then
            ${pkgs.coreutils}/bin/mkdir -p /usr/local/bin
            seed="$(${pkgs.coreutils}/bin/mktemp -d /usr/local/bin/.rex-seed-XXXXXX)"
            trap '${pkgs.coreutils}/bin/rm -rf "$seed"' EXIT
            ${pkgs.gnutar}/bin/tar -xzf ${bootstrap.src} -C "$seed" rex
            ${pkgs.coreutils}/bin/chmod 755 "$seed/rex"
            ${pkgs.coreutils}/bin/ln "$seed/rex" /usr/local/bin/rex ||
              { [ -e /usr/local/bin/rex ] || [ -L /usr/local/bin/rex ]; }
          fi
          ${lib.getExe packages.updater} --apply-only --no-restart
        '';
      };

      systemd.services.rex-update = {
        description = "Apply the Rex release pin published on main";
        wants = [ "network-online.target" ];
        after = [ "network-online.target" "rex-install.service" ];
        requires = [ "rex-install.service" ];
        path = [ pkgs.systemd ];
        environment = nativeEnvironment;
        serviceConfig = {
          Type = "oneshot";
          ExecStart = lib.getExe packages.updater;
          TimeoutStartSec = "10min";
          UMask = "0077";
        };
      };
      systemd.timers.rex-update = {
        wantedBy = [ "timers.target" ];
        timerConfig = { OnBootSec = "2min"; OnUnitInactiveSec = "15min"; };
      };

      # native replacements apply offline too; both paths share a lock.
      systemd.services.rex-apply = {
        description = "Validate and apply a native Rex replacement";
        after = [ "rex-install.service" ];
        requires = [ "rex-install.service" ];
        path = [ pkgs.systemd ];
        environment = nativeEnvironment;
        serviceConfig = {
          Type = "oneshot";
          ExecStart = "${lib.getExe packages.updater} --apply-only";
          TimeoutStartSec = "10min";
          UMask = "0077";
        };
      };
      systemd.paths.rex-apply = {
        wantedBy = [ "multi-user.target" ];
        after = [ "rex-install.service" ];
        requires = [ "rex-install.service" ];
        pathConfig.PathChanged = "/usr/local/bin/rex";
      };

      # reuse host tailscaled identity; no embedded node, public TCP, or anonymous access.
      services.rex.loginServer = {
        enable = true;
        accounts.bdsqqq.principals = [ "tailscale:igorbedesqui@gmail.com" ];
        defaults."tailscale:igorbedesqui@gmail.com" = "bdsqqq";
        tailscaleServe.enable = config.services.tailscale.enable;
      };
    })
    (lib.optionalAttrs (headMode == "graphical" && isDarwin) {
      home-manager.users.bdsqqq = { config, ... }: {
        xdg.configFile."rex".source = config.lib.file.mkOutOfStoreSymlink repoConfig;
      };
    })
  ];
}
