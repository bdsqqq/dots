{ ... }:
{
  home-manager.users.bdsqqq = { pkgs, ... }: {
      home.packages = [ pkgs.curl pkgs.jq ];
  };
}
