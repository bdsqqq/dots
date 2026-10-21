{ config, lib, pkgs, ... }:
let
  cfg = config.my.goplaces;
  apiKeyFile = if cfg.apiKeyFile != null then cfg.apiKeyFile
    else if cfg.enable && builtins.hasAttr "google_places_api_key" config.sops.secrets then config.sops.secrets.google_places_api_key.path
    else null;
  live = "${config.my.paths.commonplace}/01_files/nix/modules/goplaces/auth.ts";
in
{
  imports = [ ./credential.nix ];
  options.my.goplaces.enable = lib.mkEnableOption "authenticated Places integration (false installs only the package)";
  options.my.goplaces.apiKeyFile = lib.mkOption {
    type = lib.types.nullOr lib.types.str;
    default = null;
    description = "runtime-only Google Places API key file; may point to an existing SOPS secret";
  };

  config.my.goplaces.credential.required = lib.mkIf (cfg.enable && cfg.apiKeyFile == null) true;
  config.assertions = [{
    assertion = cfg.apiKeyFile == null || (lib.hasPrefix "/" cfg.apiKeyFile && !lib.hasPrefix "/nix/store/" cfg.apiKeyFile && cfg.apiKeyFile != "/");
    message = "my.goplaces.apiKeyFile must be a private absolute runtime file path outside the Nix store.";
  }];
  config.home-manager.users.bdsqqq = { pkgs, ... }:
    let
      # The pinned nixpkgs lacks goplaces; use hashed upstream releases, not a global install.
      # Checksums: https://github.com/openclaw/goplaces/releases/tag/v0.4.14
      assets = {
        aarch64-darwin = {
          name = "goplaces_0.4.14_darwin_arm64.tar.gz";
          hash = "sha256-cyZpbdwjv3lW7xoojf2M/P2TtVlBFzTWRS7m9AKRUE0=";
        };
        x86_64-darwin = {
          name = "goplaces_0.4.14_darwin_amd64.tar.gz";
          hash = "sha256-OY7pYv0ef4Nd5jWumbJjB95v121LPzjY1f8ltqAArXc=";
        };
        aarch64-linux = {
          name = "goplaces_0.4.14_linux_arm64.tar.gz";
          hash = "sha256-o3fp32dJUXfhNYCQ8K0nebBgQHHRZi9pQ/1SS1WgiZU=";
        };
        x86_64-linux = {
          name = "goplaces_0.4.14_linux_amd64.tar.gz";
          hash = "sha256-40Iw2W6YiPjPv0PQ2BZBX2y4L0PDYifRK67H2ZJ5a38=";
        };
      };
      asset = assets.${pkgs.stdenv.hostPlatform.system};
      package = pkgs.stdenvNoCC.mkDerivation {
        pname = "goplaces";
        version = "0.4.14";
        src = pkgs.fetchurl {
          url = "https://github.com/openclaw/goplaces/releases/download/v0.4.14/${asset.name}";
          inherit (asset) hash;
        };
        sourceRoot = ".";
        dontBuild = true;
        dontConfigure = true;
        dontStrip = true;
        installPhase = ''
          runHook preInstall
          install -Dm755 goplaces "$out/bin/goplaces"
          runHook postInstall
        '';
        meta = {
          homepage = "https://github.com/openclaw/goplaces";
          mainProgram = "goplaces";
          platforms = builtins.attrNames assets;
        };
      };
      auth = pkgs.writeShellScriptBin "goplaces-auth" ''
        export TOOL_AUTH_PLACES_ENABLED=${if cfg.enable then "1" else "0"}
        export TOOL_AUTH_PLACES_KEY_FILE=${lib.escapeShellArg (if apiKeyFile == null then "" else apiKeyFile)}
        export TOOL_AUTH_PLACES_BINARY=${package}/bin/goplaces
        exec ${pkgs.nodejs}/bin/node ${lib.escapeShellArg live} "$@"
      '';
      executable = if apiKeyFile == null then package else pkgs.writeShellScriptBin "goplaces" ''
        exec ${auth}/bin/goplaces-auth run "$@"
      '';
    in {
      home.packages = [ executable auth ];
    };
}
