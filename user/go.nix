{ ... }: {
  home-manager.users.bdsqqq = { pkgs, ... }: {
    home.packages = with pkgs; [
      go
      gopls # LSP
      gofumpt # formatter
      golangci-lint # linter
      gotools # goimports, etc.
      gotests # test generator
      delve # debugger
    ];
  };
}
