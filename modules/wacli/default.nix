{ config, lib, ... }:
let
  cfg = config.my.wacli.integration;
  source = "${config.my.paths.commonplace}/01_files/nix/modules/wacli/ready.ts";
in
{
  options.my.wacli.integration = {
    enable = lib.mkEnableOption "selected native WhatsApp integration";
    account = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Human account binding for this private linked-device store.";
    };
    storeDir = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Absolute private native wacli store; never SOPS device snapshots.";
    };
    probeGroupJid = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Approved group JID for one bounded authenticated info read; native CLI caches metadata.";
    };
  };
  config = {
    assertions = [
      {
        assertion =
          !cfg.enable
          || (
            cfg.account != null
            && cfg.account != ""
            && cfg.storeDir != null
            && lib.hasPrefix "/" cfg.storeDir
            && !(lib.hasPrefix "/nix/store/" cfg.storeDir)
            && cfg.probeGroupJid != null
            && lib.hasSuffix "@g.us" cfg.probeGroupJid
          );
        message = "wacli integration requires account, private absolute storeDir and approved probeGroupJid; pair natively and explicitly";
      }
    ];
    home-manager.users.bdsqqq =
      { pkgs, ... }:
      let
        package = (
          # v0.24.0 requires Go 1.27; keep this selection local to the fallback.
          pkgs.wacli or (pkgs.buildGo127Module {
            pname = "wacli";
            version = "0.24.0";
            src = pkgs.fetchFromGitHub {
              owner = "openclaw";
              repo = "wacli";
              tag = "v0.24.0";
              hash = "sha256-7Apg6qK8ucfMYa5w/y8Q6NCr5qyZtYpgNknkZNJXzmk=";
            };
            vendorHash = "sha256-Kcbd/If+63q4TRifEH3iZ+Doc5sF10MQLViBhsr0buE=";
            subPackages = [ "cmd/wacli" ];
            # Message search uses SQLite FTS5; upstream enables it in release builds.
            tags = [ "sqlite_fts5" ];
            ldflags = [
              "-s"
              "-w"
              "-X main.version=0.24.0"
            ];
            meta.mainProgram = "wacli";
            meta.license = pkgs.lib.licenses.mit;
          })
        );
      in
      {
        home.packages = [
          package
          (pkgs.writeShellScriptBin "wacli-ready" ''
            exec ${pkgs.nodejs_latest}/bin/node --experimental-strip-types ${lib.escapeShellArg source} ${
              lib.escapeShellArgs [
                "${package}/bin/wacli"
                (if cfg.enable then "1" else "0")
                (if cfg.account == null then "" else cfg.account)
                (if cfg.storeDir == null then "" else cfg.storeDir)
                (if cfg.probeGroupJid == null then "" else cfg.probeGroupJid)
              ]
            } "$@"
          '')
        ];
        # Native config.yaml and SQLite state remain CLI-owned and writable;
        # readiness selects an explicit store rather than a named-account default.
      };
  };
}
