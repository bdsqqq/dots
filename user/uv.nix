{ inputs, lib, hostSystem ? null, ... }:
{
  home-manager.users.bdsqqq = { inputs, config, pkgs, lib, ... }: let
    uvGlobalDir = "${config.home.homeDirectory}/commonplace/01_files/nix/uv-global";
    uvVenvDir = "${uvGlobalDir}/.venv";
    uvCacheDir = "${config.home.homeDirectory}/.local/share/uv";
  in {
    # expose UV cache location
    home.sessionVariables.UV_CACHE_DIR = uvCacheDir;

    # add venv bin to PATH
    custom.path.segments = [
      { order = 120; value = "${uvVenvDir}/bin"; }
    ];

    # ensure uv and python are available
    home.packages = with pkgs; [
      uv
      python312
      ffmpeg  # needed for audio processing
    ];

    home.activation.installUvGlobals = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      set -euo pipefail

      UV_GLOBAL_DIR="${uvGlobalDir}"
      UV_VENV_DIR="${uvVenvDir}"

      # ensure venv exists
      if [ ! -d "$UV_VENV_DIR" ]; then
        "${pkgs.uv}/bin/uv" venv "$UV_VENV_DIR" --python "${pkgs.python312}/bin/python"
      fi

      # detect cuda support at runtime
      UV_SYNC_EXTRA=""
      if command -v nvidia-smi &>/dev/null; then
        UV_SYNC_EXTRA="--extra cuda"
      fi

      # sync dependencies from pyproject.toml
      cd "$UV_GLOBAL_DIR"
      "${pkgs.uv}/bin/uv" sync $UV_SYNC_EXTRA || true
    '';

    # shell alias for adding global python packages
    programs.zsh.shellAliases = {
      uv-add = "cd ~/commonplace/01_files/nix/uv-global && uv add";
      uv-remove = "cd ~/commonplace/01_files/nix/uv-global && uv remove";
    };
  };
}
