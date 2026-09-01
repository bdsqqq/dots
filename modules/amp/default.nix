{ config, ... }:
let
  # This host is the composition point; Amp remains a capture adapter while
  # the installed pi-memory service owns every semantic pipeline stage.
  enableLocalMemory =
    (config.networking.localHostName or "") == "mbp-m2";
in
{
  home-manager.users.bdsqqq =
    { config, lib, pkgs, ... }:
    let
      # Pin installer behavior and its selected release for consistent new-host bootstraps.
      installer = pkgs.fetchurl {
        url = "https://ampcode.com/install.sh";
        hash = "sha256-gy1n7WtrRBShV47IBkwlhTJwOnxP9nW6t0CKF9hHwpE=";
      };
      memoryPlugin = pkgs.runCommand "amp-pi-memory-plugin" { } ''
        mkdir -p "$out/plugins" "$out/lib"
        cp "${./plugins/pi-memory.ts}" "$out/plugins/pi-memory.ts"
        cp "${./lib/pi-memory-adapter.ts}" "$out/lib/pi-memory-adapter.ts"
      '';
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

      home.file.".config/amp/plugins/pi-memory.ts" =
        lib.mkIf enableLocalMemory {
          source = "${memoryPlugin}/plugins/pi-memory.ts";
        };
      home.file.".config/amp/lib/pi-memory-adapter.ts" =
        lib.mkIf enableLocalMemory {
          source = "${memoryPlugin}/lib/pi-memory-adapter.ts";
        };
    };
}
