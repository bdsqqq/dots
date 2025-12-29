{ lib, inputs, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  
  sshKeyPath = if isDarwin 
    then "/Users/bdsqqq/.ssh/id_ed25519"
    else "/home/bdsqqq/.ssh/id_ed25519";
in
{
  sops = {
    # use user ssh key for decryption
    age.sshKeyPaths = [ sshKeyPath ];
    
    defaultSopsFile = inputs.self + "/secrets.yaml";
    secrets = {
      anthropic_api_key = { owner = "bdsqqq"; };
      tailscale_auth_key = { owner = "bdsqqq"; };
      axiom_token = { owner = "bdsqqq"; };
      amp_api_key = { owner = "bdsqqq"; };
      syncthing_gui_password = { owner = "bdsqqq"; };
      syncthing_gui_password_hash = { owner = "bdsqqq"; };
      cookies = {
        sopsFile = inputs.self + "/cookies.txt";
        format = "binary";
        owner = "bdsqqq";
        mode = "0400";
      };
    };
  };
}


