{ lib, inputs, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  
  sshKeyPath = if isDarwin 
    then "/Users/bdsqqq/.ssh/id_ed25519"
    else "/home/bdsqqq/.ssh/id_ed25519";
  
  homeDir = if isDarwin 
    then "/Users/bdsqqq" 
    else "/home/bdsqqq";

  bdsPiConfigFile = inputs.self + "/user/agents/bds-pi.json";
in
{
  sops = {
    age.sshKeyPaths = [ sshKeyPath ];
    
    defaultSopsFile = inputs.self + "/secrets.yaml";
    secrets = {
      anthropic_api_key = { owner = "bdsqqq"; };
      tailscale_auth_key = { owner = "bdsqqq"; };
      gh_token = { owner = "bdsqqq"; };
      hf_token = { owner = "bdsqqq"; };
      open_router = { owner = "bdsqqq"; };
      opencode_zen = { owner = "bdsqqq"; };
      artificial_analysis_api_key = { owner = "bdsqqq"; };
      motion_plus_token = { owner = "bdsqqq"; };
      AMP_API_KEY = { owner = "bdsqqq"; };
      parallel_api_key = { owner = "bdsqqq"; };
      syncthing_gui_password = { owner = "bdsqqq"; };
      syncthing_gui_password_hash = { owner = "bdsqqq"; };
      openai_codex_access = { owner = "bdsqqq"; };
      openai_codex_refresh = { owner = "bdsqqq"; };
      openai_codex_expires = { owner = "bdsqqq"; };
      openai_codex_accountId = { owner = "bdsqqq"; };

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
