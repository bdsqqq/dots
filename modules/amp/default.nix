{ config, lib, ... }:
let
  cfg = config.my.amp;
  axiomCredentialsEnabled = config.my.o11y.credential.required or false;
  axiomTokenFile = if axiomCredentialsEnabled then config.sops.secrets."axiom/personal_token".path else "";
  axiomOrgFile = if axiomCredentialsEnabled then config.sops.secrets."axiom/personal_org_id".path else "";
  credentialWrapperEnabled = cfg.apiKeyFile != null || axiomCredentialsEnabled;
  repoSettings = "${config.my.paths.commonplace}/01_files/nix/modules/amp/settings.json";
  # This host is the composition point; Amp remains a capture adapter while
  # the installed pi-memory service owns every semantic pipeline stage.
  enableLocalMemory =
    (config.networking.localHostName or "") == "mbp-m2";
in
{
  imports = [ ./credential.nix ];

  options.my.amp.apiKeyFile = lib.mkOption {
    type = lib.types.nullOr lib.types.str;
    default = null;
    description = "runtime-only file containing the Amp API key";
  };

  config.home-manager.users.bdsqqq =
    { config, lib, pkgs, ... }:
    let
      ampCredentialWrapper =
        if !credentialWrapperEnabled then
          null
        else
          pkgs.writeShellScript "amp-with-credentials" ''
            exec ${pkgs.bash}/bin/bash ${./launch-with-credentials.sh} \
              ${lib.escapeShellArg "${config.home.homeDirectory}/.amp/bin/amp"} \
              ${lib.escapeShellArg (if cfg.apiKeyFile == null then "" else cfg.apiKeyFile)} \
              ${lib.escapeShellArg axiomTokenFile} ${lib.escapeShellArg axiomOrgFile} "$@"
          '';
      memoryPlugin = pkgs.runCommand "amp-pi-memory-plugin" { } ''
        mkdir -p "$out/plugins" "$out/lib"
        cp "${./plugins/pi-memory.ts}" "$out/plugins/pi-memory.ts"
        cp "${./lib/pi-memory-adapter.ts}" "$out/lib/pi-memory-adapter.ts"
      '';
    in
    {
      custom.path.segments =
        lib.optionals credentialWrapperEnabled [
          {
            order = 70;
            value = "${config.home.homeDirectory}/.local/lib/amp-auth/bin";
          }
        ]
        ++ [
          {
            order = 90;
            value = "${config.home.homeDirectory}/.amp/bin";
          }
        ];

      home.activation.installAmp = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        if [ ! -x "${config.home.homeDirectory}/.amp/bin/amp" ]; then
          export PATH="${config.home.homeDirectory}/.local/bin:${lib.makeBinPath [ pkgs.coreutils pkgs.curl pkgs.gnugrep pkgs.gzip ]}:$PATH"
          "${pkgs.curl}/bin/curl" --proto '=https' --tlsv1.2 -fsSL https://ampcode.com/install.sh |
            "${pkgs.bash}/bin/bash"
        fi
      '';

      home.file.".local/lib/amp-auth/bin/amp" = lib.mkIf credentialWrapperEnabled {
        source = ampCredentialWrapper;
      };

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
