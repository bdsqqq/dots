{ config, ... }:
let
  repoSettings = "${config.my.paths.commonplace}/01_files/nix/modules/amp/settings.json";
  # This host is the composition point; Amp remains a capture adapter while
  # the installed pi-memory service owns every semantic pipeline stage.
  enableLocalMemory =
    (config.networking.localHostName or "") == "mbp-m2";
in
{
  home-manager.users.bdsqqq =
    { config, lib, pkgs, ... }:
    let
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
          export PATH="${config.home.homeDirectory}/.local/bin:${lib.makeBinPath [ pkgs.coreutils pkgs.curl pkgs.gnugrep pkgs.gzip ]}:$PATH"
          "${pkgs.curl}/bin/curl" --proto '=https' --tlsv1.2 -fsSL https://ampcode.com/install.sh |
            "${pkgs.bash}/bin/bash"
        fi
      '';

      home.file.".config/amp/settings.json" = {
        source = config.lib.file.mkOutOfStoreSymlink repoSettings;
        force = true;
      };

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
