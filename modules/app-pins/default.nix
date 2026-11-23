{ config, lib, pkgs, hostSystem ? null, ... }:
let
  cfg = config.my.appPins;
  user = config.my.primaryUser;
  repo = "${config.my.paths.commonplace}/01_files/nix";
  # run the live working-tree source, like node-pnpm: helper edits take effect
  # without a rebuild, and pins are written beside the modules that own them.
  cli = "${repo}/modules/app-pins/cli.ts";
  # "mbp-m5", matching the hand-written provenance, not the mDNS "mbp-m5.local".
  host = lib.removeSuffix ".local" config.networking.hostName;
  node = "${pkgs.nodejs_latest}/bin/node";
  # each module that owns an app declares it in app-pin.spec.json (see loadApps in
  # pins.ts, which reads the same files).
  declared = lib.concatMap (dir:
    let file = ../. + "/${dir}/app-pin.spec.json"; in
    lib.optional (builtins.pathExists file)
      (builtins.fromJSON (builtins.readFile file) // { pin = "modules/${dir}/app-pin.json"; })
  ) (builtins.attrNames (lib.filterAttrs (_: type: type == "directory") (builtins.readDir ../.)));
  apps = builtins.listToAttrs (map (spec: lib.nameValuePair spec.name spec) declared);
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isVendor = name: (apps.${name}.kind or "bundle") == "vendor";
  vendors = builtins.filter isVendor cfg.apps;
  # macs push over the user's ssh key; linux hosts have no trusted github host key,
  # but git's https credential helper already reads the host's gh_token.
  remote = if isDarwin then "git@github.com:bdsqqq/dots.git" else "https://github.com/bdsqqq/dots.git";
  publish = name: [ node cli "publish" "--remote" remote "--host" host ]
    ++ lib.optional isDarwin "--notify" ++ [ name ];

  # T3 updates both CLIs on request (`claude update`, `codex update`), which the
  # agents record. these turn off the CLIs' own update checks, so no host moves
  # past the pin unless someone asked for it.
  claudePolicy = builtins.toJSON { env.DISABLE_AUTOUPDATER = "1"; };
  codexPolicy = "check_for_update_on_startup = false\n";
in
{
  options.my.appPins.apps = lib.mkOption {
    type = lib.types.listOf (lib.types.enum (builtins.attrNames apps));
    default = [ ];
    description = "self-updating apps and vendor CLIs whose updates are recorded into tracked pins.";
  };

  config = lib.mkIf (cfg.apps != [ ]) (lib.mkMerge [
    {
      assertions = [{
        assertion = isDarwin || vendors == cfg.apps;
        message = "app-pins: app bundles are mac-only; linux hosts can only pin vendor CLIs";
      }];
    }

    (lib.mkIf (builtins.elem "codex" vendors) {
      environment.etc."codex/requirements.toml".text = codexPolicy;
    })

    (lib.optionalAttrs isDarwin {
      # claude reads machine policy from here on macs; nix-darwin's /etc can't reach it.
      system.activationScripts.postActivation.text = lib.mkIf (builtins.elem "claude" vendors) (lib.mkAfter ''
        install -d -m 0755 "/Library/Application Support/ClaudeCode/managed-settings.d"
        install -m 0644 ${pkgs.writeText "claude-app-pins.json" claudePolicy} \
          "/Library/Application Support/ClaudeCode/managed-settings.d/app-pins.json"
      '');

      home-manager.users.${user} = { config, lib, ... }:
      let log = "${config.home.homeDirectory}/Library/Logs/app-pins.log"; in {
        # a failed download must not block activation.
        # before the broker launchers, which record where codex lives.
        home.activation.installPinnedApps = lib.hm.dag.entryBetween [ "refreshCliProxyApiTools" ] [ "linkGeneration" ] ''
          if [ -f ${lib.escapeShellArg cli} ]; then
            PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH" ${node} ${lib.escapeShellArg cli} install \
              --repo ${lib.escapeShellArg repo} ${lib.escapeShellArgs cfg.apps} >>${lib.escapeShellArg log} 2>&1 \
              || echo >&2 "warning: app-pins install failed; see ${log}"
          fi
        '';

        # a bundle self-update replaces the whole bundle, so its Info.plist changes;
        # a vendor CLI update swaps a link in its own directories.
        launchd.agents = lib.genAttrs' cfg.apps (name: lib.nameValuePair "app-pin-${name}" {
          enable = true;
          config = {
            ProgramArguments = publish name;
            WatchPaths = if isVendor name
              then map (path: "${config.home.homeDirectory}/${path}") apps.${name}.watch
              else [ "${apps.${name}.bundle}/Contents/Info.plist" ];
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
    })

    (lib.optionalAttrs (!isDarwin) {
      environment.etc."claude-code/managed-settings.d/app-pins.json" =
        lib.mkIf (builtins.elem "claude" vendors) { text = claudePolicy; };

      home-manager.users.${user} = { config, lib, ... }:
      let
        environment = [ "PATH=/etc/profiles/per-user/${config.home.username}/bin:/run/current-system/sw/bin" ];
        # no Install section: activation would start them and wait on the downloads.
        # the timers below start them instead.
        oneshot = description: command: {
          Unit.Description = description;
          Service = {
            Type = "oneshot";
            ExecStart = lib.escapeShellArgs command;
            Environment = environment;
          };
        };
        # after boot, like the macs' RunAtLoad, then hourly: a path event that lands
        # while the service runs is dropped, and this catches it.
        timer = {
          Timer = { OnStartupSec = "2m"; OnCalendar = "hourly"; RandomizedDelaySec = "10m"; Persistent = true; };
          Install.WantedBy = [ "timers.target" ];
        };
      in {
        # path units only see changes made after they start, and pnpm no longer
        # provides these CLIs, so install right after each activation. --no-block:
        # activation must not wait on large downloads.
        home.activation.startPinnedInstall = lib.hm.dag.entryAfter [ "reloadSystemd" ] ''
          if [ -z "''${DRY_RUN_CMD:-}" ]; then
            ${pkgs.systemd}/bin/systemctl --user start --no-block app-pins-install.service \
              || echo >&2 "warning: could not start app-pins-install"
          fi
        '';

        # the auto-upgrade fast-forwards the checkout, which moves the pins; activation
        # does not rerun for a pin-only commit.
        systemd.user.services = {
          app-pins-install = oneshot "install pinned vendor CLIs"
            ([ node cli "install" "--repo" repo ] ++ vendors);
        } // lib.genAttrs' vendors (name: lib.nameValuePair "app-pin-${name}"
          (lib.recursiveUpdate (oneshot "record ${name} updates into its pin" (publish name)) {
            # updaters swap links in several steps; let them settle, like the macs' ThrottleInterval.
            Service.ExecStartPre = "${pkgs.coreutils}/bin/sleep 30";
          }));

        systemd.user.paths = {
          app-pins-install = {
            Path.PathChanged = map (name: "${repo}/${apps.${name}.pin}") vendors;
            Install.WantedBy = [ "paths.target" ];
          };
        } // lib.genAttrs' vendors (name: lib.nameValuePair "app-pin-${name}" {
          Path.PathChanged = map (path: "${config.home.homeDirectory}/${path}") apps.${name}.watch;
          Install.WantedBy = [ "paths.target" ];
        });

        systemd.user.timers = { app-pins-install = timer; }
          // lib.genAttrs' vendors (name: lib.nameValuePair "app-pin-${name}" timer);
      };
    })
  ]);
}
