{ config, lib, ... }:
let
  apiKeyFile = config.my.goplaces.apiKeyFile;
in
{
  options.my.goplaces.apiKeyFile = lib.mkOption {
    type = lib.types.nullOr lib.types.str;
    default = null;
    description = "runtime-only Google Places API key file; may point to an existing SOPS secret";
  };

  config.home-manager.users.bdsqqq = { pkgs, ... }:
    let
      # The pinned nixpkgs lacks goplaces; use hashed upstream releases, not a global install.
      # Checksums: https://github.com/openclaw/goplaces/releases/tag/v0.4.12
      assets = {
        aarch64-darwin = {
          name = "goplaces_0.4.12_darwin_arm64.tar.gz";
          hash = "sha256-27oy6mnNmq0mgdS+5NJA8SV6tgHIxyNfwG2wArDh4uQ=";
        };
        x86_64-darwin = {
          name = "goplaces_0.4.12_darwin_amd64.tar.gz";
          hash = "sha256-KQV7MFTe8bwf64kTMFNK4nICY4IOCSisBvLRoYC2XuM=";
        };
        aarch64-linux = {
          name = "goplaces_0.4.12_linux_arm64.tar.gz";
          hash = "sha256-BTwRtQv8DOAKagerMX8HegYx0GyjT2dGJZ6VOng5g+8=";
        };
        x86_64-linux = {
          name = "goplaces_0.4.12_linux_amd64.tar.gz";
          hash = "sha256-6X3CJh0BHcFVhtRoSADqmYBXhgc2aG6N/CeJZHkQzA4=";
        };
      };
      asset = assets.${pkgs.stdenv.hostPlatform.system};
      package = pkgs.stdenvNoCC.mkDerivation {
        pname = "goplaces";
        version = "0.4.12";
        src = pkgs.fetchurl {
          url = "https://github.com/openclaw/goplaces/releases/download/v0.4.12/${asset.name}";
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
      executable = if apiKeyFile == null then package else pkgs.writeShellScriptBin "goplaces" ''
        # Read only at runtime: never put the key in the Nix store or shell profile.
        GOOGLE_PLACES_API_KEY="$(${pkgs.coreutils}/bin/cat -- ${lib.escapeShellArg apiKeyFile})" || exit 1
        export GOOGLE_PLACES_API_KEY
        if [ -z "$GOOGLE_PLACES_API_KEY" ]; then
          echo "Google Places API key file is empty" >&2
          exit 1
        fi
        exec ${package}/bin/goplaces "$@"
      '';
    in {
      home.packages = [ executable ];
    };
}
