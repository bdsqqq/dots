{ lib, headMode ? "graphical", ... }:
let
  isGraphical = headMode == "graphical";
in
{
  imports =
    [
      ../user/nvim.nix
      ../user/pnpm.nix
      ../user/dev-tools.nix
      ../user/zellij.nix
    ]
    ++ lib.optionals isGraphical [
      ../user/ghostty.nix
    ];
}


