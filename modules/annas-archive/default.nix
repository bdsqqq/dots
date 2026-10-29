{ config, lib, ... }:
let
  cfg = config.my.annasArchive;
  apiKeyFile =
    if cfg.apiKeyFile != null then
      cfg.apiKeyFile
    else if cfg.enable && builtins.hasAttr "annas_archive_key" config.sops.secrets then
      config.sops.secrets.annas_archive_key.path
    else
      null;
  directory = "${config.my.paths.commonplace}/01_files/nix/modules/annas-archive";
in
{
  imports = [ ./credential.nix ];

  options.my.annasArchive = {
    enable = lib.mkEnableOption "authenticated Anna's Archive requests (false installs only the CLI)";
    apiKeyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Private absolute runtime account-key file; overrides the local SOPS owner.";
    };
    baseUrl = lib.mkOption {
      type = lib.types.str;
      default = "https://annas-archive.gl";
      description = "Explicitly trusted HTTPS origin; credentials are never forwarded across redirects.";
    };
    preferencesFile = lib.mkOption {
      type = lib.types.str;
      default = "${directory}/preferences.conf";
      description = "Editable live preference file, read on every search invocation.";
    };
  };

  config = {
    my.annasArchive.credential.required = lib.mkIf (cfg.enable && cfg.apiKeyFile == null) true;
    assertions = [
      {
        assertion =
          cfg.apiKeyFile == null
          || (
            lib.hasPrefix "/" cfg.apiKeyFile
            && cfg.apiKeyFile != "/"
            && cfg.apiKeyFile != "/nix/store"
            && !(lib.hasPrefix "/nix/store/" cfg.apiKeyFile)
          );
        message = "my.annasArchive.apiKeyFile must be a private absolute runtime file path outside the Nix store.";
      }
      {
        assertion = builtins.match "https://[a-zA-Z0-9][a-zA-Z0-9.-]*(:[0-9]+)?/?" cfg.baseUrl != null;
        message = "my.annasArchive.baseUrl must be an HTTPS origin without credentials, a path, query, or fragment.";
      }
    ];

    home-manager.users.bdsqqq =
      {
        pkgs,
        lib,
        config,
        ...
      }:
      {
        # Install from the same live manifest that Node resolves at runtime.
        home.activation.installAnnaDependencies = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
          set -euo pipefail
          export CI=true
          export XDG_CONFIG_HOME=${lib.escapeShellArg config.xdg.configHome}
          export XDG_DATA_HOME=${lib.escapeShellArg config.xdg.dataHome}
          export XDG_CACHE_HOME=${lib.escapeShellArg config.xdg.cacheHome}
          export PATH="${
            lib.makeBinPath [
              pkgs.nodejs_24
              pkgs.pnpm_12
            ]
          }:$PATH"
          ${pkgs.pnpm_12}/bin/pnpm install --dir ${lib.escapeShellArg directory} --frozen-lockfile
        '';
        home.packages = [
          (pkgs.writeShellScriptBin "anna" ''
            export ANNAS_ARCHIVE_ENABLED=${if cfg.enable then "1" else "0"}
            export ANNAS_ARCHIVE_KEY_FILE=${lib.escapeShellArg (if apiKeyFile == null then "" else apiKeyFile)}
            export ANNAS_ARCHIVE_BASE_URL=${lib.escapeShellArg cfg.baseUrl}
            export ANNAS_ARCHIVE_PREFERENCES_FILE=${lib.escapeShellArg cfg.preferencesFile}
            exec ${pkgs.nodejs_24}/bin/node --experimental-strip-types ${lib.escapeShellArg "${directory}/cli.ts"} "$@"
          '')
        ];
      };
  };
}
