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
      globalDir = "${pnpmHome}/global";
      # pnpm 10 keeps the mutable global project under global/5. `pnpm i -g`
      # reads package.json there, so the repo manifest must be linked at this path.
      globalProjectDir = "${globalDir}/5";
      configDir = "${config.home.homeDirectory}/commonplace/01_files/nix/user/node-pnpm";
      manifestPath = "${configDir}/global-package.json";
      workspacePath = "${configDir}/pnpm-workspace.yaml";
      configYamlPath = "${configDir}/config.yaml";
      configRcPath = "${configDir}/rc";
      activationPath = lib.makeBinPath (
        [
          pkgs.nodejs
          pkgs.pnpm
          pkgs.python3
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
          value = pnpmHome;
        }
        {
          order = 110;
          value = "${globalProjectDir}/node_modules/.bin";
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
        GLOBAL_DIR="${globalDir}"
        GLOBAL_PROJECT_DIR="${globalProjectDir}"
        MANIFEST="${manifestPath}"
        WORKSPACE="${workspacePath}"
        CONFIG_YAML="${configYamlPath}"
        CONFIG_RC="${configRcPath}"
        export PNPM_HOME
        export CI=true
        export PYTHON="${pkgs.python3}/bin/python3"
        export PATH="${pnpmHome}:${activationPath}:$PATH"

        mkdir -p "$PNPM_HOME" "$GLOBAL_PROJECT_DIR" "${config.xdg.configHome}/pnpm"

        # pnpm 10 reads rc; pnpm 11 reads config.yaml. keep both linked so edits made
        # with pnpm config or package-manager commands can be committed from the repo.
        ln -sf "$CONFIG_YAML" "${config.xdg.configHome}/pnpm/config.yaml"
        ln -sf "$CONFIG_RC" "${config.xdg.configHome}/pnpm/rc"
        ln -sf "$MANIFEST" "$GLOBAL_PROJECT_DIR/package.json"
        ln -sf "$WORKSPACE" "$GLOBAL_PROJECT_DIR/pnpm-workspace.yaml"

        "${pkgs.pnpm}/bin/pnpm" install --dir "$GLOBAL_PROJECT_DIR" --prod --no-frozen-lockfile || true

        NODE_MODULE_ABI="$(${pkgs.nodejs}/bin/node -p 'process.versions.modules')"
        ABI_STAMP="$GLOBAL_PROJECT_DIR/.node-module-abi"
        if [ -d "$GLOBAL_PROJECT_DIR/node_modules/.pnpm" ] && [ "$(cat "$ABI_STAMP" 2>/dev/null || true)" != "$NODE_MODULE_ABI" ]; then
          "${pkgs.pnpm}/bin/pnpm" rebuild --dir "$GLOBAL_PROJECT_DIR" better-sqlite3
          printf '%s\n' "$NODE_MODULE_ABI" > "$ABI_STAMP"
        fi

        if [ -d "$GLOBAL_PROJECT_DIR/node_modules/.bin" ]; then
          for bin in "$GLOBAL_PROJECT_DIR/node_modules/.bin"/*; do
            name="$(basename "$bin")"
            [ "$name" = "pi" ] && continue
            wrapper="$PNPM_HOME/$name"
            rm -f "$wrapper"
            printf '%s\n' \
              '#!/usr/bin/env bash' \
              "exec \"$bin\" \"\$@\"" \
              > "$wrapper"
            chmod +x "$wrapper"
          done
        fi
      '';
    };
}
