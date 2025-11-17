{ lib, inputs, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  keyFile = if isDarwin 
    then "/Users/bdsqqq/.config/sops/age/keys.txt"
    else "/var/lib/sops-nix/key.txt";
  
  keyExists = builtins.pathExists keyFile;
in
{
  warnings = lib.optional (!keyExists) 
    "sops age key not found at ${keyFile} - secrets will not be decrypted. run ssh-to-age to generate key from ssh key.";

  sops = lib.mkIf keyExists {
    age.keyFile = keyFile;
    defaultSopsFile = inputs.self + "/secrets.yaml";
    secrets = {
      anthropic_api_key = { };
      tailscale_auth_key = { };
    };
  };
}


