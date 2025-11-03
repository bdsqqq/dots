{ lib, inputs, hostSystem ? null, ... }:
{
  # common sops-nix settings; key location differs per OS
  sops = {
    age = if lib.hasInfix "darwin" hostSystem then {
      keyFile = "/Users/bdsqqq/.config/sops/age/keys.txt";
    } else {
      keyFile = "/var/lib/sops-nix/key.txt";
    };

    # default encrypted file and concrete secrets mapping (flake root)
    defaultSopsFile = inputs.self + "/secrets.yaml";
    secrets = {
      anthropic_api_key = { };
      tailscale_auth_key = { };
    };
  };
}


