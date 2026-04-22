{ ... }: {
  home-manager.users.bdsqqq = { pkgs, ... }: {
    home.packages = with pkgs; [
      nil # LSP
      nixfmt # formatter
      statix # linter
    ];
  };
}
