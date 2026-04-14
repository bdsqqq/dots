{ pkgs, lib, config, hostSystem ? null, ... }:

let
  isLinux = lib.hasInfix "linux" hostSystem;
  cfg = config.my.login;

  tuigreetCommand = "${pkgs.tuigreet}/bin/tuigreet --sessions /run/current-system/sw/share/wayland-sessions --remember --remember-session";

  # quickshell-root: a derivation containing the complete quickshell greetd frontend.
  # lives in the nix store alongside the launcher — no dependency on /etc/static, which
  # gets clobbered by nixos-upgrade.timer. the greeter user (uid 997) cannot read
  # /home or ~/.config, so everything lives in the store.
  quickshellRoot = pkgs.symlinkJoin {
    name = "quickshell-greeter-root";
    paths = [ ../user/quickshell ];  # ./greetd-shell.qml etc.
  };

  # launcher: runs the quickshell GUI under cage, falls back to tuigreet on failure.
  # the fallback is the safety circuit: "it crashed" means "you just locked yourself
  # out of the box" — we cannot let that happen.
  quickshellLauncher = pkgs.writeShellScriptBin "quickshell-greeter-launcher" ''
    set -eu

    QS_ROOT=${quickshellRoot}  # symlinkJoin puts paths at $out/ root, not a subdir
    QS_ENTRY=$QS_ROOT/greetd-shell.qml
    QS_CACHE_DIR=/var/cache/quickshell-greetd

    # greeter user has no XDG_RUNTIME_DIR. cage needs one to create its wayland socket.
    # create a temp dir owned by greeter; it persists for the greeter session.
    export XDG_RUNTIME_DIR=/run/user/997
    mkdir -p $XDG_RUNTIME_DIR
    chown greeter:greeter $XDG_RUNTIME_DIR
    chmod 0700 $XDG_RUNTIME_DIR

    # GPU access for rendering. render node is world-readable on most distros.
    # if this is wrong on a specific host, the fallback to tuigreet saves us.
    export QT_WAYLAND_DISABLE_WINDOWDECORATION=1

    # launch quickshell inside cage (single-purpose wayland compositor for greeters)
    # cage exits when quickshell exits, so the greeter session is bounded to the GUI lifetime.
    if QS_GREETD_CFG_DIR=$QS_CACHE_DIR \
       ${pkgs.cage}/bin/cage -- \
       ${pkgs.quickshellWrapped}/bin/quickshell -p "$QS_ENTRY"; then
      exit 0
    fi

    # gui crashed or couldn't start — fall back to the known-good tuigreet.
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
      # quickshellLauncher is added to greetd's command. quickshellRoot lives in the
      # nix store alongside it — no /etc/ involvement, survives nixos-upgrade.timer.

      # greetd needs /var/cache before the launcher runs.
      systemd.tmpfiles.rules = [
        "d /var/cache/quickshell-greetd 0770 greeter greeter - -"
      ];
    })
  ];
}
