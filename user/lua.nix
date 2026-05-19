{ ... }: {
  home-manager.users.bdsqqq = { pkgs, ... }: {
    home.packages = with pkgs; [
      lua-language-server # LSP: lua_ls
      stylua # formatter
    ];
  };
}
