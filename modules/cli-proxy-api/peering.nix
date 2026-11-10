{ config, lib, pkgs, hostSystem, options, ... }:
let
  cfg = config.my.cliProxyApi.peering;
  home = config.home-manager.users.${config.my.primaryUser}.home.homeDirectory;
  live = config.my.cliProxyApi.sourceDirectory;
  isDarwin = lib.hasSuffix "-darwin" hostSystem;
  runner = pkgs.writeShellScriptBin "inference-peering" ''
    # Source changes reload the agent; native membership/keys remain private and editable.
    # peering: ${builtins.hashFile "sha256" ./peering.ts}
    # broker: ${builtins.hashFile "sha256" ./broker.ts}
    # credentials: ${builtins.hashFile "sha256" ../tool-auth/process.ts}
    exec ${pkgs.nodejs_24}/bin/node ${lib.escapeShellArg "${live}/peering.ts"} \
      ${lib.escapeShellArg cfg.nodeId} ${toString cfg.port} ${lib.escapeShellArg cfg.configFile}
  '';
in
{
  options.my.cliProxyApi.peering = {
    enable = lib.mkEnableOption "opt-in one-hop HTTP/SSE inference delegation";
    nodeId = lib.mkOption {
      type = lib.types.strMatching "[a-z0-9][a-z0-9-]{0,62}";
      default = lib.removeSuffix ".local" config.networking.hostName;
      description = "Stable execution-owner identity; Darwin's mDNS suffix is not part of peer membership.";
    };
    port = lib.mkOption { type = lib.types.port; default = 18817; };
    configFile = lib.mkOption {
      type = lib.types.str;
      default = "${home}/.local/share/inference-peering/config.json";
      description = "Private membership and credential-file references; never OAuth grants or store-backed secrets.";
    };
    package = lib.mkOption { type = lib.types.package; readOnly = true; default = runner; internal = true; };
  };
  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      assertions = [
        { assertion = isDarwin && config.my.cliProxyApi.hub.enable; message = "peering currently requires an independently enrolled Darwin gateway"; }
        { assertion = lib.hasPrefix "/" cfg.configFile && !lib.hasPrefix "/nix/store" cfg.configFile; message = "peering membership and credentials must remain outside the Nix store"; }
      ];
      home-manager.users.${config.my.primaryUser}.home.packages = [ runner ];
    }
    (lib.optionalAttrs isDarwin {
      home-manager.users.${config.my.primaryUser}.launchd.agents.inference-peering = {
        enable = true;
        domain = "user";
        config = {
          Label = "dev.cli-proxy-api.peering";
          ProgramArguments = [ "${runner}/bin/inference-peering" ];
          WorkingDirectory = home;
          RunAtLoad = true;
          KeepAlive = true;
          ThrottleInterval = 10;
          ProcessType = "Background";
          Umask = 63;
          StandardOutPath = "${home}/Library/Logs/inference-peering.log";
          StandardErrorPath = "${home}/Library/Logs/inference-peering.log";
        };
      };
    })
    (lib.optionalAttrs (options.my ? tailnetRegistry) {
      my.tailnetRegistry.services.inference-peer = {
        title = "inference peer";
        description = "authenticated execution-only peer API; HTTP/SSE prototype, not native management";
        target = "http://127.0.0.1:${toString cfg.port}";
        scheme = "https";
        port = cfg.port;
        path = "/health";
        healthPath = "/health";
        access.tailnet = "owner";
        adoptExisting = true;
      };
    })
  ]);
}
