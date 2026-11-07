{
  config,
  lib,
  pkgs,
  hostSystem,
  ...
}:
let
  cfg = config.my.inferenceArchive;
  home = config.home-manager.users.${config.my.primaryUser}.home.homeDirectory;
  live = "${config.my.paths.commonplace}/01_files/nix/modules/inference-archive";
  isDarwin = lib.hasSuffix "-darwin" hostSystem;
  recorderConfig = pkgs.writeText "inference-capture.json" (
    builtins.toJSON {
      root = cfg.directory;
      inherit (cfg)
        edgePort
        upstreamPort
        healthPort
        reserveBytes
        spoolLimitBytes
        maxPayloadBytes
        maxMessageBytes
        ;
      brokerOrigin = "http://127.0.0.1:${toString config.my.cliProxyApi.port}";
      codexOrigin = "https://chatgpt.com";
    }
  );
  recorder = pkgs.writeShellScriptBin "inference-capture" ''
    # Published source changes reload the service, while native edits still run live.
    # service: ${builtins.hashFile "sha256" ./service.ts}
    # capture: ${builtins.hashFile "sha256" ./capture.ts}
    # journal: ${builtins.hashFile "sha256" ./journal.ts}
    # dependencies: ${builtins.hashFile "sha256" ./pnpm-lock.yaml}
    # manifest: ${builtins.hashFile "sha256" ./package.json}
    exec ${pkgs.nodejs_24}/bin/node ${lib.escapeShellArg "${live}/service.ts"} ${recorderConfig} "$@"
  '';
in
{
  imports = [ ./database.nix ];
  options.my.inferenceArchive = {
    enable = lib.mkEnableOption "durable local inference capture";
    directory = lib.mkOption {
      type = lib.types.str;
      default = "${home}/.local/share/inference-archive";
      description = "Private append-only source journals and ingestion receipts, outside native account state.";
    };
    edgePort = lib.mkOption {
      type = lib.types.port;
      default = 18317;
    };
    upstreamPort = lib.mkOption {
      type = lib.types.port;
      default = 18318;
    };
    healthPort = lib.mkOption {
      type = lib.types.port;
      default = 18319;
    };
    reserveBytes = lib.mkOption {
      type = lib.types.ints.unsigned;
      default = 5 * 1024 * 1024 * 1024;
    };
    spoolLimitBytes = lib.mkOption {
      type = lib.types.ints.positive;
      default = 8 * 1024 * 1024 * 1024;
    };
    maxPayloadBytes = lib.mkOption {
      type = lib.types.ints.positive;
      default = 128 * 1024 * 1024;
    };
    maxMessageBytes = lib.mkOption {
      type = lib.types.ints.between 1 (16 * 1024 * 1024);
      default = 16 * 1024 * 1024;
    };
    package = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      default = recorder;
      internal = true;
    };
    configuration = lib.mkOption {
      type = lib.types.path;
      readOnly = true;
      default = recorderConfig;
      internal = true;
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.maxMessageBytes <= cfg.maxPayloadBytes;
        message = "a complete websocket message must fit the exchange payload budget";
      }
      {
        assertion = isDarwin;
        message = "the inference recorder currently deploys on the home Darwin broker";
      }
      {
        assertion = config.my.cliProxyApi.hub.enable;
        message = "durable capture requires the local CLIProxyAPI hub";
      }
      {
        assertion = lib.hasPrefix "/" cfg.directory && !(lib.hasPrefix "/nix/store/" cfg.directory);
        message = "inference journals must be private writable runtime files";
      }
    ];
    home-manager.users.${config.my.primaryUser} = { config, lib, ... }: {
      home.packages = [ recorder ];
      # Install and run from one live manifest. Source edits need a native reload,
      # dependency changes also need the normal frozen-lockfile installation.
      home.activation.inferenceArchiveDependencies = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
        # frozen lock: ${builtins.hashFile "sha256" ./pnpm-lock.yaml}
        # manifest: ${builtins.hashFile "sha256" ./package.json}
        export CI=true
        export PATH="${
          lib.makeBinPath [
            pkgs.nodejs_24
            pkgs.pnpm_12
          ]
        }:$PATH"
        ${pkgs.pnpm_12}/bin/pnpm install --dir ${lib.escapeShellArg live} --frozen-lockfile
      '';
      launchd.agents.inference-capture = {
        enable = true;
        domain = "user";
        config = {
          Label = "dev.inference-archive.capture";
          ProgramArguments = [ "${recorder}/bin/inference-capture" ];
          WorkingDirectory = config.home.homeDirectory;
          RunAtLoad = true;
          KeepAlive = true;
          ThrottleInterval = 10;
          ProcessType = "Background";
          Umask = 63;
          ExitTimeOut = 15;
          StandardOutPath = "${config.home.homeDirectory}/Library/Logs/inference-capture.log";
          StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/inference-capture.log";
        };
      };
    };
    my.cliProxyApi.codexArchiveBaseUrl = "http://127.0.0.1:${toString cfg.upstreamPort}/backend-api/codex";
    # The public URL stays stable; it no longer bypasses durable client capture.
    my.tailnetRegistry.services.cli-proxy-api.target =
      lib.mkForce "http://127.0.0.1:${toString cfg.edgePort}";
    my.tailnetRegistry.services.inference-archive = {
      title = "inference capture";
      description = "durable journal writer and storage readiness; query indexing is independent";
      target = "http://127.0.0.1:${toString cfg.healthPort}";
      scheme = "https";
      port = cfg.healthPort;
      path = "/ready";
      healthPath = "/health";
      readinessPath = "/ready";
      access.tailnet = "owner";
      adoptExisting = true;
    };
  };
}
