{ ... }:
{
  home-manager.users.bdsqqq = { pkgs, ... }: {
      home.packages = [ pkgs.openhue-cli ];
  };
}
