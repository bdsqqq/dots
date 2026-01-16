{ lib, inputs, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  
  sshKeyPath = if isDarwin 
    then "/Users/bdsqqq/.ssh/id_ed25519"
    else "/home/bdsqqq/.ssh/id_ed25519";
  
  homeDir = if isDarwin 
    then "/Users/bdsqqq" 
    else "/home/bdsqqq";
in
{
  sops = {
    age.sshKeyPaths = [ sshKeyPath ];
    
    defaultSopsFile = inputs.self + "/secrets.yaml";
    secrets = {
      anthropic_api_key = { owner = "bdsqqq"; };
      tailscale_auth_key = { owner = "bdsqqq"; };
      gh_token = { owner = "bdsqqq"; };
      motion_plus_token = { owner = "bdsqqq"; };
      AMP_API_KEY = { owner = "bdsqqq"; };
      syncthing_gui_password = { owner = "bdsqqq"; };
      syncthing_gui_password_hash = { owner = "bdsqqq"; };
      
      # axiom config - decrypted to ~/.axiom.toml
      "axiom.toml" = {
        sopsFile = inputs.self + "/.axiom.toml";
        format = "binary";
        owner = "bdsqqq";
        mode = "0400";
        path = "${homeDir}/.axiom.toml";
      };
      
      cookies = {
        sopsFile = inputs.self + "/cookies.txt";
        format = "binary";
        owner = "bdsqqq";
        mode = "0400";
      };
    };
  };
}


