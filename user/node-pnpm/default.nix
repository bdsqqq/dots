{ ... }:
{
  home-manager.users.bdsqqq =
    {
      config,
      pkgs,
      lib,
      ...
    }:
    let
      pnpmHome = "${config.home.homeDirectory}/.local/share/pnpm";
      pnpmBin = "${pnpmHome}/bin";
      globalDir = "${pnpmHome}/global";
      # pnpm keeps the mutable global project under global/5. Keep this path
      # explicit so native rebuild checks can inspect the actual global store.
      globalProjectDir = "${globalDir}/5";
      configDir = "${config.home.homeDirectory}/commonplace/01_files/nix/user/node-pnpm";
      configYamlPath = "${configDir}/config.yaml";
      workspacePath = "${configDir}/pnpm-workspace.yaml";
      globalPackages = (builtins.fromJSON (builtins.readFile ./global-package.json)).dependencies;
      globalPackageSpecs = lib.mapAttrsToList (name: version: "${name}@${version}") globalPackages;
      activationPath = lib.makeBinPath (
        [
          pkgs.nodejs
          pkgs.node-gyp
          pkgs.pnpm
          pkgs.python3
          pkgs.findutils
          pkgs.unzip
        ]
        ++ lib.optionals pkgs.stdenv.isLinux [
          pkgs.gcc
          pkgs.gnumake
        ]
      );
    in
    {
      home.sessionVariables.PNPM_HOME = pnpmHome;

      custom.path.segments = [
        {
          order = 100;
          value = pnpmBin;
        }
      ];

      home.packages = [
        pkgs.nodejs
        pkgs.pnpm
        pkgs.unzip
      ];

      xdg.configFile."qmd/index.yml" = {
        force = true;
        text = ''
          collections:
            agent-memories:
              path: ${config.home.homeDirectory}/commonplace/01_files/_utilities/agent-memories
              pattern: "**/*.md"
          models:
            embed: hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf
            generate: hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf
            rerank: hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf
        '';
      };

      home.activation.installPnpmGlobals = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        set -euo pipefail

        PNPM_HOME="${pnpmHome}"
        PNPM_BIN="${pnpmBin}"
        GLOBAL_PROJECT_DIR="${globalProjectDir}"
        CONFIG_YAML="${configYamlPath}"
        WORKSPACE="${workspacePath}"
        export PNPM_HOME
        export CI=true
        export npm_config_build_from_source=true
        export npm_config_python="${pkgs.python3}/bin/python3"
        export PYTHON="${pkgs.python3}/bin/python3"
        export PATH="$PNPM_BIN:${activationPath}:$PATH"

        mkdir -p "$PNPM_HOME" "$PNPM_BIN" "$GLOBAL_PROJECT_DIR" "${config.xdg.configHome}/pnpm"

        ln -sf "$CONFIG_YAML" "${config.xdg.configHome}/pnpm/config.yaml"
        ln -sf "$WORKSPACE" "$GLOBAL_PROJECT_DIR/pnpm-workspace.yaml"

        "${pkgs.pnpm}/bin/pnpm" add --global ${lib.escapeShellArgs globalPackageSpecs}

        NODE_MODULE_ABI="$(${pkgs.nodejs}/bin/node -p 'process.versions.modules')"
        HOST_PLATFORM="$(${pkgs.nodejs}/bin/node -p 'process.platform + \"-\" + process.arch')"
        ABI_STAMP="$GLOBAL_PROJECT_DIR/.node-module-abi"
        PLATFORM_STAMP="$GLOBAL_PROJECT_DIR/.node-platform"
        BETTER_SQLITE_BINDING=""
        if [ -d "$GLOBAL_PROJECT_DIR/.pnpm" ]; then
          BETTER_SQLITE_BINDING="$(
            find "$GLOBAL_PROJECT_DIR/.pnpm" \
              -path "*/node_modules/better-sqlite3/build/Release/better_sqlite3.node" \
              -print \
              -quit
          )"
        fi
        if [ -d "$GLOBAL_PROJECT_DIR/.pnpm" ] && {
          [ "$(cat "$ABI_STAMP" 2>/dev/null || true)" != "$NODE_MODULE_ABI" ] ||
          [ "$(cat "$PLATFORM_STAMP" 2>/dev/null || true)" != "$HOST_PLATFORM" ] ||
          [ -z "$BETTER_SQLITE_BINDING" ] ||
          [ ! -e "$BETTER_SQLITE_BINDING" ];
        }; then
          "${pkgs.pnpm}/bin/pnpm" rebuild --global better-sqlite3
          printf '%s\n' "$NODE_MODULE_ABI" > "$ABI_STAMP"
          printf '%s\n' "$HOST_PLATFORM" > "$PLATFORM_STAMP"
        fi
      '';
    };
}
