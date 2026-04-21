{ lib, headMode ? "graphical", ... }:
let
  isGraphical = headMode == "graphical";
in
{
  imports =
    [
      ../user/nvim
      ../user/git
      ../user/bun.nix
      ../user/dev-tools.nix
      ../user/trash.nix
      (import ../zmx.nix).module
      ../user/direnv.nix
      ../user/rust.nix
      ../user/go.nix
      ../user/nix.nix
      ../user/fairy-name.nix
      ../user/tmux.nix
      ../user/opencode
      ../user/pi
      ../user/agents
    ]
    ++ lib.optionals isGraphical [
      ../user/ghostty.nix
    ];
}


