{ ... }: {
  home-manager.users.bdsqqq = { pkgs, ... }: {
    home.packages = with pkgs; [
      typescript # tsserver runtime used by typescript-language-server
      typescript-language-server # LSP: ts_ls
    ];
  };
}
