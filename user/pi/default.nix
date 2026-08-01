{ config
, lib
, inputs
, ...
}:
let
  commonplaceRoot = config.my.paths.commonplace;
  repoPi = "${commonplaceRoot}/01_files/nix/user/pi";
  # repo path for mkOutOfStoreSymlink — edits take effect immediately without rebuild
  repoExtensions = "${repoPi}/packages/extensions";
  piChatExtension = "${repoPi}/packages/optional/pi-chat";
  repoAgentPrompts = "${commonplaceRoot}/01_files/nix/user/agents/agents";
in
{
  home-manager.users.bdsqqq =
    { pkgs
    , config
    , lib
    , ...
    }:
    let
      piChat = pkgs.writeShellApplication {
        name = "pi-chat";
        runtimeInputs = [
          pkgs.nodejs
          pkgs.qemu
          pkgs.tmux
        ];
        text = ''
          umask 077
          export PI_BIN="${commonplaceRoot}/01_files/nix/user/node-pnpm/node_modules/.bin/pi"
          export PI_CHAT_COMMONPLACE_ROOT="${commonplaceRoot}"
          cd "$PI_CHAT_COMMONPLACE_ROOT"

          exec "$PI_BIN" \
            --no-extensions \
            --no-skills \
            --no-prompt-templates \
            --no-context-files \
            -e "${piChatExtension}" \
            "$@"
        '';
      };
    in
    {
      home.packages = [ piChat ];

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
                pkgs.bun
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

      launchd.agents.pi-chat-workers = lib.mkIf pkgs.stdenv.isDarwin {
        enable = true;
        config = {
          ProgramArguments = [ "${piChat}/bin/pi-chat" "-p" "/chat-spawn-all" ];
          RunAtLoad = true;
          StartInterval = 60;
          ProcessType = "Background";
          StandardOutPath = "${config.home.homeDirectory}/Library/Logs/pi-chat-workers.log";
          StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/pi-chat-workers.log";
        };
      };

      # agent definitions — shared plaintext prompt files from the repo
      home.file.".pi/agent/agents".source = config.lib.file.mkOutOfStoreSymlink "${repoAgentPrompts}";
    };
}
