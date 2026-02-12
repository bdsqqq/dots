{ lib, headMode ? "graphical", ... }:
let
  isGraphical = headMode == "graphical";
in
{
  imports =
    [
      ../user/nvim
      ../user/git
      ../user/pnpm.nix
      ../user/uv.nix
      ../user/dev-tools.nix
      ../user/direnv.nix
      ../user/rust.nix
      ../user/tmux.nix
      ../user/amp
      ../user/agents
    ]
    ++ lib.optionals isGraphical [
      ../user/ghostty.nix
    ];
}


