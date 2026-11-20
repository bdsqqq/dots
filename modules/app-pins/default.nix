{ config, lib, pkgs, hostSystem ? null, ... }:
let
  cfg = config.my.appPins;
  repo = "${config.my.paths.commonplace}/01_files/nix";
  # run the live working-tree source, like node-pnpm: helper edits take effect
  # without a rebuild, and pins are written beside the modules that own them.
  pins = "${repo}/modules/app-pins/pins.ts";
  node = "${pkgs.nodejs_latest}/bin/node";
  apps = builtins.fromJSON (builtins.readFile ./apps.json);
in
{
  options.my.appPins.apps = lib.mkOption {
    type = lib.types.listOf (lib.types.enum (builtins.attrNames apps));
    default = [ ];
    description = "self-updating mac apps whose updates are recorded into tracked pins.";
  };

  config = lib.mkIf (lib.hasInfix "darwin" hostSystem && cfg.apps != [ ]) {
    home-manager.users.${config.my.primaryUser} = { config, lib, ... }: {
      # first install only: missing or older apps get the pinned build; newer or
      # running apps are left alone. a failed download must not block activation.
      home.activation.installPinnedApps = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
        if [ -f ${lib.escapeShellArg pins} ]; then
          PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH" ${node} ${lib.escapeShellArg pins} install \
            ${lib.escapeShellArg repo} ${lib.escapeShellArgs cfg.apps} >/dev/null \
            || echo >&2 "warning: app-pins install failed; see the app-pins events above"
        fi
      '';

      # each self-update replaces the whole bundle, so its Info.plist changes.
      launchd.agents = lib.genAttrs' cfg.apps (name: lib.nameValuePair "app-pin-${name}" {
        enable = true;
        config = {
          ProgramArguments = [ node pins "record" repo name "--notify" ];
          WatchPaths = [ "${apps.${name}.bundle}/Contents/Info.plist" ];
          RunAtLoad = true;
          # updaters swap bundles in several steps; let them settle.
          ThrottleInterval = 30;
          ProcessType = "Background";
          EnvironmentVariables.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
          StandardOutPath = "${config.home.homeDirectory}/Library/Logs/app-pins.log";
          StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/app-pins.log";
        };
      });
    };
  };
}
