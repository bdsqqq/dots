{ pkgs, ... }:

let
  companyMoney = pkgs.callPackage ./package.nix { nodejs = pkgs.nodejs_latest; };
in
{
  home-manager.users.bdsqqq.home.packages = [ companyMoney ];
}
