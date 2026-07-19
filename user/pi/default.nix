{ config
, lib
, inputs
, ...
}:
let
  repoPi = "${config.my.paths.commonplace}/01_files/nix/user/pi";
  # repo path for mkOutOfStoreSymlink — edits take effect immediately without rebuild
  repoExtensions = "${repoPi}/packages/extensions";
  repoAgentPrompts = "${config.my.paths.commonplace}/01_files/nix/user/agents/agents";
in
{
  home-manager.users.bdsqqq =
    { pkgs
    , config
    , lib
    , ...
    }:
    {
      home.file.".pi/agent/settings.json".source =
        config.lib.file.mkOutOfStoreSymlink "${repoPi}/settings.json";
      home.file.".pi/agent/tool-policy.json".source =
        config.lib.file.mkOutOfStoreSymlink "${repoPi}/tool-policy.json";
      home.file.".pi/agent/keybindings.json".source =
        config.lib.file.mkOutOfStoreSymlink "${repoPi}/keybindings.json";
      home.file.".pi/agent/models.json".source =
        config.lib.file.mkOutOfStoreSymlink "${repoPi}/models.json";

      # extensions — single directory symlink, pi scans subdirectories for package.json with pi.extensions
      home.file.".pi/agent/extensions".source = config.lib.file.mkOutOfStoreSymlink "${repoExtensions}";

      # install workspace deps declaratively for all extension packages
      home.activation.installPiExtensionDeps = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
        set -euo pipefail

        if [ -f "${repoPi}/package.json" ]; then
          export CI=true
          export PATH="${
            lib.makeBinPath (
              [
                pkgs.nodejs
                pkgs.pnpm
                pkgs.python3
              ]
              ++ lib.optionals pkgs.stdenv.isLinux [
                pkgs.gcc
                pkgs.gnumake
              ]
            )
          }:$PATH"
          "${pkgs.pnpm}/bin/pnpm" install --dir "${repoPi}" --frozen-lockfile
        fi
      '';

      # agent definitions — shared plaintext prompt files from the repo
      home.file.".pi/agent/agents".source = config.lib.file.mkOutOfStoreSymlink "${repoAgentPrompts}";
    };
}
