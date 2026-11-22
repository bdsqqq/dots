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
          # upstream's release build: compiling 0.24.0 needs Go 1.27, which hydra
          # doesn't cache here, and the build ran small hosts out of memory.
          # the release is built with sqlite_fts5, which message search needs.
          pkgs.wacli or (let
            version = "0.24.0";
            platform = {
              x86_64-linux = { name = "linux_amd64"; hash = "sha256-TKXGaNQfaLrRi/EueWarp8GzzGrjL9jhRd65h93RGS0="; };
              aarch64-linux = { name = "linux_arm64"; hash = "sha256-bg+1RHPesPuHgjk88fIfDB47szAbNlHNnZp3tjePDgc="; };
              aarch64-darwin = { name = "darwin_arm64"; hash = "sha256-1HQWsbZ/rHr5WT+aVvHMpvN36ksEhqh2bbuA8Qz9728="; };
            }.${pkgs.stdenv.hostPlatform.system};
          in pkgs.stdenv.mkDerivation {
            pname = "wacli";
            inherit version;
            src = pkgs.fetchurl {
              url = "https://github.com/openclaw/wacli/releases/download/v${version}/wacli_${version}_${platform.name}.tar.gz";
              inherit (platform) hash;
            };
            sourceRoot = ".";
            nativeBuildInputs = pkgs.lib.optional pkgs.stdenv.hostPlatform.isLinux pkgs.autoPatchelfHook;
            dontConfigure = true;
            dontBuild = true;
            installPhase = "install -Dm755 wacli $out/bin/wacli";
            meta.mainProgram = "wacli";
            meta.license = pkgs.lib.licenses.mit;
            meta.sourceProvenance = [ pkgs.lib.sourceTypes.binaryNativeCode ];
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
