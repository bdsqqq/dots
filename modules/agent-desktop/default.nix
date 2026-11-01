{ config, lib, hostSystem ? "", ... }:
# Do not introduce macOS binaries or session assumptions on Linux hosts.
lib.optionalAttrs (lib.hasInfix "darwin" hostSystem) (
  let
    directory = "${config.my.paths.commonplace}/01_files/nix/modules/agent-desktop";
    architecture = if hostSystem == "aarch64-darwin" then "arm64" else "x64";
    nativeBin = "${directory}/node_modules/agent-desktop/bin";
  in
  {
    home-manager.users.bdsqqq = { pkgs, lib, ... }: {
      # Consent remains manual in the actual launching app. Accessibility is
      # required; screenshots additionally need Screen Recording. See README.md:
      # a stable path is NOT a stable signed TCC identity across upgrades.
      home.activation.installAgentDesktop = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
        set -euo pipefail
        export CI=true
        export PATH="${lib.makeBinPath [ pkgs.nodejs_latest pkgs.pnpm_12 ]}:$PATH"
        ${pkgs.pnpm_12}/bin/pnpm install --dir ${lib.escapeShellArg directory} --frozen-lockfile --ignore-scripts
      '';

      home.packages = [
        (pkgs.writeShellScriptBin "agent-desktop" ''
          # The npm archive already contains both executables. Execute directly
          # so neither Node nor an install-time download is needed for UI calls.
          export AGENT_DESKTOP_MACOS_HELPER_PATH=${lib.escapeShellArg "${nativeBin}/agent-desktop-macos-helper-darwin-${architecture}"}
          exec ${lib.escapeShellArg "${nativeBin}/agent-desktop-darwin-${architecture}"} "$@"
        '')
      ];
    };
  }
)
