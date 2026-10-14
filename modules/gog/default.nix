{ ... }:
{
  home-manager.users.bdsqqq = { pkgs, ... }: {
    home.packages = [ pkgs.gogcli ];
    # Native config writes use rename, replacing file symlinks. Keep config and
    # private OAuth/keyring state CLI-owned; no useful nonsecret default is needed.
  };
}
