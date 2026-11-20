{ config, lib, pkgs, hostSystem ? null, ... }:
let
  cfg = config.my.appPins;
  repo = "${config.my.paths.commonplace}/01_files/nix";
  # run the live working-tree source, like node-pnpm: helper edits take effect
  # without a rebuild, and pins are written beside the modules that own them.
  cli = "${repo}/modules/app-pins/cli.ts";
  # "mbp-m5", matching the hand-written provenance, not the mDNS "mbp-m5.local".
  host = lib.removeSuffix ".local" config.networking.hostName;
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
    home-manager.users.${config.my.primaryUser} = { config, lib, ... }:
    let log = "${config.home.homeDirectory}/Library/Logs/app-pins.log"; in {
      # a failed download must not block activation.
      home.activation.installPinnedApps = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
        if [ -f ${lib.escapeShellArg cli} ]; then
          PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH" ${node} ${lib.escapeShellArg cli} install \
            --repo ${lib.escapeShellArg repo} ${lib.escapeShellArgs cfg.apps} >>${lib.escapeShellArg log} 2>&1 \
            || echo >&2 "warning: app-pins install failed; see ${log}"
        fi
      '';

      # each self-update replaces the whole bundle, so its Info.plist changes.
      launchd.agents = lib.genAttrs' cfg.apps (name: lib.nameValuePair "app-pin-${name}" {
        enable = true;
        config = {
          ProgramArguments = [ node cli "publish" "--remote" "git@github.com:bdsqqq/dots.git" "--host" host "--notify" name ];
          WatchPaths = [ "${apps.${name}.bundle}/Contents/Info.plist" ];
          RunAtLoad = true;
          # updaters swap bundles in several steps; let them settle.
          ThrottleInterval = 30;
          ProcessType = "Background";
          # the user's git (signing, identity) and ssh are the same as an interactive push.
          EnvironmentVariables.PATH = "/etc/profiles/per-user/${config.home.username}/bin:/usr/bin:/bin:/usr/sbin:/sbin";
          StandardOutPath = log;
          StandardErrorPath = log;
        };
      });
    };
  };
}
