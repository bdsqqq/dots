{ pkgs, ... }:

let
  companyMoney = pkgs.callPackage ./package.nix { };
in
{
  home-manager.users.bdsqqq.home.packages = [ companyMoney ];
}
