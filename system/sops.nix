{ lib, inputs, hostSystem ? null, config, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
  
  keyPath = if isDarwin 
    then "/Users/bdsqqq/.config/sops/age/keys.txt"
    else "/var/lib/sops-nix/key.txt";
  
  keyExists = builtins.pathExists keyPath;
in
{
  sops = {
    age.keyFile = keyPath;
    defaultSopsFile = inputs.self + "/secrets.yaml";
    
    # only declare secrets if key exists, otherwise they'll fail to decrypt
    secrets = lib.mkIf keyExists {
      anthropic_api_key = { };
      tailscale_auth_key = { };
    };
  };
  
  # warn if key file doesn't exist
  warnings = lib.optional 
    (!keyExists)
    "sops age key file not found at ${keyPath} - secrets will not be available. run: sudo mkdir -p $(dirname ${keyPath}) && ssh-to-age -private-key -i ~/.ssh/id_ed25519 | sudo tee ${keyPath}";
}


