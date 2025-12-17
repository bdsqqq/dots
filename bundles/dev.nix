{ lib, headMode ? "graphical", ... }:
let
  isGraphical = headMode == "graphical";
in
{
  imports =
    [
      ../user/nvim
      ../user/pnpm.nix
      ../user/dev-tools.nix
      ../user/zellij.nix
      ../user/tmux.nix
      ../user/amp
    ]
    ++ lib.optionals isGraphical [
      ../user/ghostty.nix
    ];
}


