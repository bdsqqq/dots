{ config, lib, pkgs, hostSystem, options, ... }:
let
  cfg = config.my.cliProxyApi;
  home = config.home-manager.users.${config.my.primaryUser}.home.homeDirectory;
  live = cfg.sourceDirectory;
  isDarwin = lib.hasSuffix "-darwin" hostSystem;
  broker = pkgs.writeShellScriptBin "inference-broker" ''
    # Published runner changes produce a new service command; local edits still run live.
    # runner: ${builtins.hashFile "sha256" ./broker.ts}
    # Live npm CLI shims need Node even when a native harness omits it from PATH.
    export PATH="''${PATH:-/usr/bin:/bin}:${pkgs.nodejs_24}/bin"
    ${lib.optionalString cfg.hub.enable ''
      export CLI_PROXY_API_BIN="''${CLI_PROXY_API_BIN:-${lib.getExe cfg.package}}"
      export CLI_PROXY_API_STATE_DIR="''${CLI_PROXY_API_STATE_DIR:-${cfg.stateDirectory}}"
      export CLI_PROXY_API_BASE_URL="''${CLI_PROXY_API_BASE_URL:-${cfg.baseUrl}}"
      export CLI_PROXY_API_PORT="''${CLI_PROXY_API_PORT:-${toString cfg.port}}"
      ${lib.optionalString (cfg.codexArchiveBaseUrl != null) ''
        export CLI_PROXY_API_CODEX_ARCHIVE_BASE_URL=${lib.escapeShellArg cfg.codexArchiveBaseUrl}
      ''}
    ''}
    exec ${pkgs.nodejs_24}/bin/node ${lib.escapeShellArg "${live}/broker.ts"} "$@"
  '';
  nativeClient = program: pkgs.writeShellScriptBin "${program}-broker" ''
    ${lib.optionalString (program == "claude") ''
      if [ -z "''${CLAUDE_BIN:-}" ] && ! command -v claude >/dev/null 2>&1; then
        export CLAUDE_BIN=${lib.escapeShellArg (lib.getExe pkgs.claude-code)}
      fi
    ''}
    exec ${broker}/bin/inference-broker run ${program} "$@"
  '';
  tools = pkgs.symlinkJoin {
    name = "cli-proxy-api-tools";
    paths = [ broker (nativeClient "claude") (nativeClient "codex") ];
  };
in
{
  options.my.cliProxyApi = {
    hub.enable = lib.mkEnableOption "a private native CLIProxyAPI gateway";
    hub.publish = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Publish gateway model, management and health routes through the tailnet registry. Disable for loopback-only gateways.";
    };
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.cliproxyapi.overrideAttrs (old: {
        patches = (old.patches or [ ]) ++ [ ./codex-archive-route.patch ];
        doCheck = true;
        checkPhase = ''
          runHook preCheck
          go test ./internal/runtime/executor -run '^TestArchiveCodexCreds' -count=1
          runHook postCheck
        '';
      });
      description = "CLIProxyAPI with the explicit OAuth upstream-route regression fix for durable capture.";
    };
    sourceDirectory = lib.mkOption {
      type = lib.types.str;
      default = "${config.my.paths.commonplace}/01_files/nix/modules/cli-proxy-api";
      description = "Editable canonical tracked module sources used by both installation and runtime; bootstrap sets this explicitly for relocated checkouts.";
    };
    toolsPackage = lib.mkOption { type = lib.types.package; readOnly = true; default = tools; internal = true; };
    stateDirectory = lib.mkOption {
      type = lib.types.str;
      default = "${home}/.local/share/cli-proxy-api";
      description = "Private, writable native configuration, account grants, and best-effort request logs; never synchronized.";
    };
    baseUrl = lib.mkOption {
      type = lib.types.str;
      default = "https://mmn-m4.tail1543a7.ts.net:8317";
      description = "Client-facing gateway origin (HTTPS remote or numeric loopback HTTP capture frontend); contains no credential.";
    };
    codexArchiveBaseUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Default OAuth Codex upstream recorder; account refresh remains native and outside inference capture.";
    };
    port = lib.mkOption { type = lib.types.port; default = 8317; };
  };

  config = lib.mkMerge [
    {
      home-manager.users.${config.my.primaryUser}.home = {
        packages = [ tools ] ++ lib.optional cfg.hub.enable cfg.package;
        # Same guarded updater as native bootstrap; absolute T3 launchers follow this
        # stable root while live TypeScript remains in the canonical checkout.
        activation.refreshCliProxyApiTools = {
          after = [ "linkGeneration" ];
          before = [ ];
          data = ''
            if [ -z "''${DRY_RUN_CMD:-}" ]; then
              codex_path="$(command -v codex || true)"
              if [ -z "$codex_path" ] && [ -x ${lib.escapeShellArg "${home}/.local/bin/codex"} ]; then
                codex_path=${lib.escapeShellArg "${home}/.local/bin/codex"}
              fi
              ${pkgs.nodejs_24}/bin/node ${lib.escapeShellArg "${live}/fleet.ts"} refresh-tools ${tools} ''${codex_path:+"$codex_path"}
            fi
          '';
        };
      };
    }
    (lib.mkIf cfg.hub.enable {
      assertions = [
        { assertion = isDarwin; message = "native CLIProxyAPI gateways currently support Darwin; other platforms install client wrappers only"; }
        { assertion = !cfg.hub.publish || options.my ? tailnetRegistry; message = "publishing a CLIProxyAPI gateway requires the tailnet-registry module"; }
        {
          assertion = lib.hasPrefix "/" cfg.stateDirectory && !lib.hasPrefix "/nix/store" cfg.stateDirectory;
          message = "CLIProxyAPI state must remain private and writable outside the Nix store";
        }
      ];
    })
    (lib.mkIf (cfg.hub.enable && cfg.hub.publish) (lib.optionalAttrs (options.my ? tailnetRegistry) {
      my.tailnetRegistry.services.cli-proxy-api = {
        title = "inference broker";
        description = "CLIProxyAPI management and model routing; request logs are not the durable archive";
        target = "http://127.0.0.1:${toString cfg.port}";
        scheme = "https";
        port = cfg.port;
        path = "/management.html";
        healthPath = "/";
        access.tailnet = "owner";
        # Native bootstrap creates this exact route without activating unrelated changes.
        adoptExisting = true;
      };
    }))
    (lib.mkIf cfg.hub.enable (lib.optionalAttrs isDarwin {
      home-manager.users.${config.my.primaryUser}.launchd.agents.cli-proxy-api = {
        enable = true;
        domain = "user";
        config = {
          Label = "dev.cli-proxy-api.broker";
          ProgramArguments = [ "${broker}/bin/inference-broker" "serve" ];
          WorkingDirectory = home;
          RunAtLoad = true;
          KeepAlive = true;
          ThrottleInterval = 10;
          ProcessType = "Background";
          Umask = 63;
          StandardOutPath = "${home}/Library/Logs/cli-proxy-api.log";
          StandardErrorPath = "${home}/Library/Logs/cli-proxy-api.log";
        };
      };
    }))
  ];
}
