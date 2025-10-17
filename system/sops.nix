{ lib, pkgs, inputs, ... }:
{
  # common sops-nix settings; key location differs per OS
  sops = {
    age = if pkgs.stdenv.isDarwin then {
      keyFile = "/Users/bdsqqq/.config/sops/age/keys.txt";
    } else {
      keyFile = "/var/lib/sops-nix/key.txt";
    };

    # default encrypted file and concrete secrets mapping
    defaultSopsFile = ../../secrets.yaml;
    secrets = {
      anthropic_api_key = { };
    };
  };
}


