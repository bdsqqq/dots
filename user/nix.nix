{ ... }:
{
  home-manager.users.bdsqqq = { pkgs, ... }: {
    home.packages = with pkgs; [
      nil               # LSP
      nixfmt-classic    # formatter
      statix            # linter
    ];
  };
}
