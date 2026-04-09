{ pkgs, lib, config, hostSystem ? null, ... }:

let
  isLinux = lib.hasInfix "linux" hostSystem;
  cfg = config.my.login;

  tuigreetCommand = "${pkgs.tuigreet}/bin/tuigreet --sessions /run/current-system/sw/share/wayland-sessions --remember --remember-session";
  quickshellEntry = "/etc/quickshell-greeter/greetd-shell.qml";
  quickshellCommand = "QS_GREETD_CFG_DIR=/var/cache/quickshell-greetd ${pkgs.cage}/bin/cage -- ${pkgs.quickshellWrapped}/bin/quickshell -p ${quickshellEntry}";
  quickshellLauncher = pkgs.writeShellScriptBin "quickshell-greeter-launcher" ''
    set -u

    # keep the experimental greeter on a short leash.
    # why: a login manager is one of the few places where "it crashed" can mean
    # "you just locked yourself out of the box". if the gui greeter returns nonzero,
    # we immediately drop back to the known-good tuigreet path.
    if ${quickshellCommand}; then
      exit 0
    fi

    exec ${tuigreetCommand}
  '';
in
if !isLinux then {} else {
  options.my.login.greeter = lib.mkOption {
    type = lib.types.enum [ "tuigreet" "quickshell" ];
    default = "tuigreet";
    description = ''
      login greeter implementation.

      default stays on `tuigreet` because display-manager failures are uniquely
      annoying to recover from over ssh or from another host. the quickshell path
      is opt-in and intended to live behind a specialisation until it has survived
      real boots.
    '';
  };

  config = lib.mkMerge [
    {
      services.greetd = {
        enable = true;
        settings.default_session = lib.mkIf (!(config.jovian.steam.autoStart or false)) {
          # `tuigreet` stays the default. experimental paths must earn their way in.
          command = if cfg.greeter == "quickshell"
            then "${quickshellLauncher}/bin/quickshell-greeter-launcher"
            else tuigreetCommand;
          user = "greeter";
        };
      };

      # ensure wayland session desktop files are available to both tuigreet and the
      # quickshell controller's session discovery.
      environment.pathsToLink = [ "/share/wayland-sessions" ];
    }

    (lib.mkIf (cfg.greeter == "quickshell") {
      # the greeter user cannot read your home checkout. copy the quickshell root
      # into /etc so the config is readable before any user has authenticated.
      environment.etc."quickshell-greeter".source = ../user/quickshell;

      # persistence lives in a greeter-owned cache dir instead of a real user's home.
      systemd.tmpfiles.rules = [
        "d /var/cache/quickshell-greetd 0770 greeter greeter - -"
      ];
    })
  ];
}
