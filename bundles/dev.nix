{ lib, headMode ? "graphical", torchBackend ? null, ... }:
let
  isGraphical = headMode == "graphical";
in
{
  _module.args.torchBackend = torchBackend;

  imports =
    [
      ../user/nvim
      ../user/git.nix
      ../user/pnpm.nix
      ../user/uv.nix
      ../user/dev-tools.nix
      ../user/zellij.nix
      ../user/tmux.nix
      ../user/amp
      ../user/agent-skills.nix
    ]
    ++ lib.optionals isGraphical [
      ../user/ghostty.nix
    ];
}


