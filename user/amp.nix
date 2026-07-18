{ ... }:
{
  home-manager.users.bdsqqq =
    { config, lib, pkgs, ... }:
    let
      # Pin installer behavior and its selected release for consistent new-host bootstraps.
      installer = pkgs.fetchurl {
        url = "https://ampcode.com/install.sh";
        hash = "sha256-TOq3GvT1oSbY/+DhrzsG8hC+Z+rpPI5Fg3k6UgZPwuI=";
      };
    in
    {
      custom.path.segments = [
        {
          order = 90;
          value = "${config.home.homeDirectory}/.amp/bin";
        }
      ];

      home.activation.installAmp = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        if ! command -v amp >/dev/null 2>&1 && [ ! -x "${config.home.homeDirectory}/.amp/bin/amp" ]; then
          export AMP_VERSION="0.0.1784391370-g49c6a1"
          export PATH="${config.home.homeDirectory}/.local/bin:${lib.makeBinPath [ pkgs.coreutils pkgs.curl pkgs.gnugrep pkgs.gzip ]}:$PATH"
          "${pkgs.bash}/bin/bash" "${installer}"
        fi
      '';
    };
}
