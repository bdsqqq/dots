{ lib, pkgs, inputs, ... }:
{
  imports = (if pkgs.stdenv.isDarwin then [ inputs.sops-nix.darwinModules.sops ] else [ inputs.sops-nix.nixosModules.sops ]);

  # common sops-nix settings; key location differs per OS
  sops = {
    age = if pkgs.stdenv.isDarwin then {
      keyFile = "/Users/bdsqqq/.config/sops/age/keys.txt";
    } else {
      keyFile = "/var/lib/sops-nix/key.txt";
    };
  };
}


