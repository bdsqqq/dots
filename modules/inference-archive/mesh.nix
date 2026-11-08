{
  config,
  lib,
  pkgs,
  options,
  ...
}:
let
  cfg = config.my.inferenceArchive;
  user = config.my.primaryUser;
  home = config.home-manager.users.${user}.home.homeDirectory;
  live = "${config.my.paths.commonplace}/01_files/nix/modules/inference-archive";
  runtimePath = lib.types.addCheck lib.types.str (
    p: lib.hasPrefix "/" p && p != "/" && !lib.hasPrefix "/nix/store" p
  );
  collectorConfig = pkgs.writeText "inference-collector.json" (
    builtins.toJSON {
      root = cfg.collector.directory;
      host = "127.0.0.1";
      inherit (cfg.collector)
        port
        keysFile
        reserveBytes
        maxBytes
        ;
    }
  );
  routerConfig = pkgs.writeText "inference-archive-router.json" (
    builtins.toJSON {
      port = cfg.collector.routerPort;
      collectorPort = cfg.collector.port;
      databasePort = config.my.inferenceArchive.database.port;
    }
  );
  publisherConfig = pkgs.writeText "inference-publisher.json" (
    builtins.toJSON {
      root = cfg.directory;
      inherit (cfg) nodeId;
      inherit (cfg.replication) endpoint tokenFile;
    }
  );
  collector = pkgs.writeShellScriptBin "inference-collector" ''
    # source: ${builtins.hashFile "sha256" ./collector.ts}
    # protocol: ${builtins.hashFile "sha256" ./replication-protocol.ts}
    # store: ${builtins.hashFile "sha256" ./replication-store.ts}
    # verifier: ${builtins.hashFile "sha256" ./verify.ts}
    umask 077
    exec ${pkgs.nodejs_24}/bin/node ${lib.escapeShellArg "${live}/collector.ts"} ${collectorConfig}
  '';
  router = pkgs.writeShellScriptBin "inference-archive-router" ''
    # source: ${builtins.hashFile "sha256" ./archive-router.ts}
    exec ${pkgs.nodejs_24}/bin/node ${lib.escapeShellArg "${live}/archive-router.ts"} ${routerConfig}
  '';
  publisher = pkgs.writeShellScriptBin "inference-publisher" ''
    # source: ${builtins.hashFile "sha256" ./replicate.ts}
    # protocol: ${builtins.hashFile "sha256" ./replication-protocol.ts}
    # store: ${builtins.hashFile "sha256" ./replication-store.ts}
    # verifier: ${builtins.hashFile "sha256" ./verify.ts}
    umask 077
    exec ${pkgs.nodejs_24}/bin/node ${lib.escapeShellArg "${live}/replicate.ts"} ${publisherConfig}
  '';
  linuxService = command: description: {
    Unit.Description = description;
    Service = {
      ExecStart = command;
      Restart = "on-failure";
      RestartSec = 10;
      UMask = "0077";
    };
    Install.WantedBy = [ "default.target" ];
  };
  macAgent = command: {
    enable = true;
    domain = "user";
    config = {
      ProgramArguments = [ command ];
      RunAtLoad = true;
      KeepAlive = true;
      ThrottleInterval = 10;
      ProcessType = "Background";
      Umask = 63;
      StandardErrorPath = "${home}/Library/Logs/inference-publisher.log";
    };
  };
in
{
  options.my.inferenceArchive = {
    nodeId = lib.mkOption {
      type = lib.types.strMatching "[a-z0-9][a-z0-9-]{0,62}";
      default = config.networking.hostName;
    };
    replication = {
      package = lib.mkOption {
        type = lib.types.package;
        readOnly = true;
        default = publisher;
      };
      enable = lib.mkEnableOption "asynchronous archive replication independent of inference";
      endpoint = lib.mkOption {
        type = lib.types.str;
        default = "https://htz-lab.tail1543a7.ts.net:18923/archive";
      };
      tokenFile = lib.mkOption {
        type = runtimePath;
        default = "${home}/.config/inference-archive/upload.key";
      };
      configuration = lib.mkOption {
        type = lib.types.path;
        readOnly = true;
        default = publisherConfig;
      };
    };
    collector = {
      package = lib.mkOption {
        type = lib.types.package;
        readOnly = true;
        default = collector;
      };
      routerPackage = lib.mkOption {
        type = lib.types.package;
        readOnly = true;
        default = router;
      };
      enable = lib.mkEnableOption "shared durable multi-node archive collector";
      directory = lib.mkOption {
        type = runtimePath;
        default = cfg.directory;
      };
      port = lib.mkOption {
        type = lib.types.port;
        default = 18925;
      };
      routerPort = lib.mkOption {
        type = lib.types.port;
        default = 18927;
      };
      keysFile = lib.mkOption {
        type = runtimePath;
        default = "${home}/.config/inference-archive-collector/keys.json";
      };
      reserveBytes = lib.mkOption {
        type = lib.types.ints.positive;
        default = 8 * 1024 * 1024 * 1024;
      };
      maxBytes = lib.mkOption {
        type = lib.types.ints.positive;
        default = 24 * 1024 * 1024 * 1024;
      };
      configuration = lib.mkOption {
        type = lib.types.path;
        readOnly = true;
        default = collectorConfig;
      };
    };
  };
  config = lib.mkMerge [
    (lib.mkIf cfg.replication.enable {
      home-manager.users.${user} = {
        home.packages = [ publisher ];
        launchd.agents = lib.optionalAttrs pkgs.stdenv.hostPlatform.isDarwin {
          inference-publisher = macAgent "${publisher}/bin/inference-publisher";
        };
        systemd.user.services = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          inference-publisher = linuxService "${publisher}/bin/inference-publisher" "asynchronous inference journal publisher";
        };
      };
    })
    (lib.mkIf cfg.collector.enable {
      assertions = [
        {
          assertion = pkgs.stdenv.hostPlatform.isLinux;
          message = "shared collector currently deploys on the Linux query host";
        }
      ];
      # Reuse the existing private TLS port and grants. /archive is a separate
      # authenticated API; SQL requests retain their existing auth and endpoint.
      my = lib.optionalAttrs (options.my ? tailnetRegistry) {
        tailnetRegistry.services.inference-archive-database.target = lib.mkForce "http://127.0.0.1:${toString cfg.collector.routerPort}";
      };
      home-manager.users.${user} = {
        home.packages = [
          collector
          router
        ];
        systemd.user.services = {
          inference-collector = linuxService "${collector}/bin/inference-collector" "durable multi-node inference collector";
          inference-archive-router = linuxService "${router}/bin/inference-archive-router" "private archive and query ingress";
        };
      };
    })
  ];
}
