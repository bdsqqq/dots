{ ... }:
{
  home-manager.users.bdsqqq = { pkgs, ... }:
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
    in {
      home.packages = [ package ];
    };
}
