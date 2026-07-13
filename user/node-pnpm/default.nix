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
      configDir = "${config.home.homeDirectory}/commonplace/01_files/nix/user/node-pnpm";
      configYamlPath = "${configDir}/config.yaml";
      globalPackages = (builtins.fromJSON (builtins.readFile ./global-package.json)).dependencies;
      globalPackageSpecs = lib.mapAttrsToList (name: version: "${name}@${version}") globalPackages;
      allowedBuildPackages = [
        "@google/genai"
        "@sentry/cli"
        "agent-browser"
        "better-sqlite3"
        "core-js"
        "cpu-features"
        "edgedriver"
        "esbuild"
        "geckodriver"
        "koffi"
        "msgpackr-extract"
        "node-pty"
        "node-llama-cpp"
        "parallel-web-cli"
        "protobufjs"
        "sqlite-vec"
        "ssh2"
        "tree-sitter-go"
        "tree-sitter-javascript"
        "tree-sitter-python"
        "tree-sitter-rust"
        "tree-sitter-typescript"
      ];
      allowBuildArgs = map (name: "--allow-build=${name}") allowedBuildPackages;
      activationPath = lib.makeBinPath (
        [
          pkgs.nodejs
          pkgs.node-gyp
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
        CONFIG_YAML="${configYamlPath}"
        export PNPM_HOME
        export CI=true
        export npm_config_build_from_source=true
        export npm_config_python="${pkgs.python3}/bin/python3"
        export PYTHON="${pkgs.python3}/bin/python3"
        export PATH="$PNPM_BIN:${activationPath}:$PATH"

        mkdir -p "$PNPM_HOME" "$PNPM_BIN" "${config.xdg.configHome}/pnpm"
        ln -sf "$CONFIG_YAML" "${config.xdg.configHome}/pnpm/config.yaml"

        "${pkgs.pnpm}/bin/pnpm" add --global \
          ${lib.escapeShellArgs allowBuildArgs} \
          ${lib.escapeShellArgs globalPackageSpecs}
      '';
    };
}
