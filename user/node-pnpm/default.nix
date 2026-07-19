{ config, ... }:
let
  toolsDir = "${config.my.paths.commonplace}/01_files/nix/user/node-pnpm";
  toolsBin = "${toolsDir}/node_modules/.bin";
  homeDir = builtins.dirOf config.my.paths.commonplace;
in
{
  home-manager.users.bdsqqq =
    { pkgs
    , lib
    , ...
    }:
    let
      activationPath = lib.makeBinPath (
        [
          pkgs.nodejs
          pkgs.node-gyp
          pkgs.pnpm
          pkgs.python3
          pkgs.gnumake
          pkgs.unzip
        ]
        ++ lib.optionals pkgs.stdenv.isLinux [
          pkgs.gcc
        ]
      );
    in
    {
      custom.path.segments = [
        {
          order = 100;
          value = toolsBin;
        }
      ];

      home.packages = [
        pkgs.nodejs
        pkgs.pnpm
        pkgs.unzip
      ];

      xdg.configFile."pnpm/config.yaml" = {
        force = true;
        source = ./config.yaml;
      };

      xdg.configFile."qmd/index.yml" = {
        force = true;
        text = ''
          collections:
            agent-memories:
              path: ${config.my.paths.commonplace}/01_files/_utilities/agent-memories
              pattern: "**/*.md"
            pi-sessions:
              path: ${homeDir}/.local/share/pi-memory/pi-sessions
              pattern: "**/*.md"
          models:
            embed: hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf
            generate: hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf
            rerank: hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf
        '';
      };

      home.activation.installPnpmTools = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
        set -euo pipefail

        export CI=true
        export NODE_NO_WARNINGS=1
        export npm_config_python="${pkgs.python3}/bin/python3"
        export PYTHON="${pkgs.python3}/bin/python3"
        export PATH="${activationPath}:$PATH"

        "${pkgs.pnpm}/bin/pnpm" install \
          --dir "${toolsDir}" \
          --frozen-lockfile \
          --reporter=append-only
      '';
    };
}
