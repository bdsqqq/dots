{ inputs, lib, hostSystem ? null, torchBackend ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  # darwin uses pypi (MPS support), linux needs explicit backend
  extraFlag = if isDarwin then "" else if torchBackend != null then "--extra ${torchBackend}" else "--extra cpu";
in
{
  home-manager.users.bdsqqq = { inputs, config, pkgs, lib, ... }: let
    uvGlobalDir = "${config.home.homeDirectory}/commonplace/01_files/nix/uv-global";
    uvVenvDir = "${uvGlobalDir}/.venv";
    uvCacheDir = "${config.home.homeDirectory}/.local/share/uv";
  in {
    home.sessionVariables.UV_CACHE_DIR = uvCacheDir;

    custom.path.segments = [
      { order = 120; value = "${uvVenvDir}/bin"; }
    ];

    home.packages = with pkgs; [
      uv
      python312
      ffmpeg
    ];

    home.activation.installUvGlobals = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      set -euo pipefail

      UV_GLOBAL_DIR="${uvGlobalDir}"
      UV_VENV_DIR="${uvVenvDir}"

      if [ ! -d "$UV_VENV_DIR" ]; then
        "${pkgs.uv}/bin/uv" venv "$UV_VENV_DIR" --python "${pkgs.python312}/bin/python"
      fi

      cd "$UV_GLOBAL_DIR"
      "${pkgs.uv}/bin/uv" sync ${extraFlag} || true
    '';

    programs.zsh.shellAliases = {
      uv-add = "cd ~/commonplace/01_files/nix/uv-global && uv add";
      uv-remove = "cd ~/commonplace/01_files/nix/uv-global && uv remove";
    };
  };
}
