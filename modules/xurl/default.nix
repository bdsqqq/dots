{ config, lib, ... }:
let
  cfg = config.my.xurl.integration;
  source = "${config.my.paths.commonplace}/01_files/nix/modules/xurl/ready.ts";
  credentialFile =
    if cfg.credentialFile != null then cfg.credentialFile
    else if cfg.enable && cfg.authMode == "bootstrap" && builtins.hasAttr "xurl_app" config.sops.secrets then
      config.sops.secrets.xurl_app.path
    else null;
in
{
  imports = [ ./credential.nix ];
  options.my.xurl.integration = {
    enable = lib.mkEnableOption "selected native X integration";
    account = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Exact native OAuth2 username, without @.";
    };
    app = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Exact registered native X app name.";
    };
    nativeHome = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Private HOME containing native mutable .xurl state.";
    };
    nativeStateFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Explicit declaration of nativeHome/.xurl/auth.yml; refreshed state is never activation-managed.";
    };
    authMode = lib.mkOption {
      type = lib.types.enum [
        "native"
        "bootstrap"
      ];
      default = "native";
      description = "Existing authorized native app, or explicit static-app bootstrap; neither activates consent.";
    };
    credentialFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Private static JSON app credentials for explicit --bootstrap only.";
    };
  };
  config = {
    my.xurl.credential.required =
      lib.mkIf (cfg.enable && cfg.authMode == "bootstrap" && cfg.credentialFile == null) true;
    assertions = [
      {
        assertion =
          !cfg.enable
          || (
            cfg.account != null
            && cfg.account != ""
            && cfg.app != null
            && cfg.app != ""
            && cfg.nativeHome != null
            && lib.hasPrefix "/" cfg.nativeHome
            && !(lib.hasPrefix "/nix/store/" cfg.nativeHome)
            && cfg.nativeStateFile == "${cfg.nativeHome}/.xurl/auth.yml"
          );
        message = "xurl integration requires exact account, app, private nativeHome and nativeStateFile declaration";
      }
      {
        assertion =
          !cfg.enable
          || cfg.authMode != "bootstrap"
          || (
            credentialFile != null
            && lib.hasPrefix "/" credentialFile
            && !(lib.hasPrefix "/nix/store/" credentialFile)
          );
        message = "xurl bootstrap mode requires a declared private static app credentialFile or enabled credential owner";
      }
    ];
    home-manager.users.bdsqqq =
      { pkgs, ... }:
      let
        # The pinned nixpkgs lacks xurl; use hashed upstream releases, not a global install.
        # Checksums: https://github.com/xdevplatform/xurl/releases/tag/v1.3.4
        assets = {
          aarch64-darwin = {
            name = "xurl_Darwin_arm64.tar.gz";
            hash = "sha256-cJf4sST6DoKlZhC2ePGfc/Dzg/Q76nyNyRuQrBOJUYE=";
          };
          x86_64-darwin = {
            name = "xurl_Darwin_x86_64.tar.gz";
            hash = "sha256-txmhVOQuA/jwlVtykg3nbZjPrVq1uSOBnX0bFmkr988=";
          };
          aarch64-linux = {
            name = "xurl_Linux_arm64.tar.gz";
            hash = "sha256-axdRmm17oBLBd7UJHflgrL9ZvxSxArBViqbZ9l62av4=";
          };
          x86_64-linux = {
            name = "xurl_Linux_x86_64.tar.gz";
            hash = "sha256-kwuT5J1GZkuHIPvas9FnBWQbqMDCMrL3K3Oc5jX1fkM=";
          };
        };
        asset = assets.${pkgs.stdenv.hostPlatform.system};
        package = pkgs.stdenvNoCC.mkDerivation {
          pname = "xurl";
          version = "1.3.4";
          src = pkgs.fetchurl {
            url = "https://github.com/xdevplatform/xurl/releases/download/v1.3.4/${asset.name}";
            inherit (asset) hash;
          };
          sourceRoot = ".";
          dontBuild = true;
          dontConfigure = true;
          dontStrip = true;
          installPhase = ''
            runHook preInstall
            install -Dm755 xurl "$out/bin/xurl"
            runHook postInstall
          '';
          meta = {
            homepage = "https://github.com/xdevplatform/xurl";
            mainProgram = "xurl";
            platforms = builtins.attrNames assets;
          };
        };
      in
      {
        home.packages = [
          package
          (pkgs.writeShellScriptBin "xurl-ready" ''
            exec ${pkgs.nodejs}/bin/node --experimental-strip-types ${lib.escapeShellArg source} ${
              lib.escapeShellArgs [
                "${package}/bin/xurl"
                "${pkgs.yq-go}/bin/yq"
                (if cfg.enable then "1" else "0")
                (if cfg.nativeHome == null then "" else cfg.nativeHome)
                (if cfg.app == null then "" else cfg.app)
                (if cfg.account == null then "" else cfg.account)
                (if cfg.authMode != "bootstrap" || credentialFile == null then "" else credentialFile)
              ]
            } "$@"
          '')
        ];
      };
  };
}
