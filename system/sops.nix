{ lib, inputs, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;

  sshKeyPath =
    if isDarwin then
      "/Users/bdsqqq/.ssh/id_ed25519"
    else
      "/home/bdsqqq/.ssh/id_ed25519";

  homeDir = if isDarwin then "/Users/bdsqqq" else "/home/bdsqqq";

  bdsPiConfigFile = inputs.self + "/user/agents/bds-pi.json";
in
{
  sops = {
    age.sshKeyPaths = [ sshKeyPath ];

    defaultSopsFile = ../secrets.yaml;
    secrets = {
      tailscale_auth_key = { owner = "bdsqqq"; };
      gh_token = { owner = "bdsqqq"; };
      hf_token = { owner = "bdsqqq"; };
      artificial_analysis_api_key = { owner = "bdsqqq"; };
      motion_plus_token = { owner = "bdsqqq"; };
      parallel_api_key = { owner = "bdsqqq"; };
      syncthing_gui_password = { owner = "bdsqqq"; };
      syncthing_gui_password_hash = { owner = "bdsqqq"; };
      "axiom/personal_url" = {
        sopsFile = ./o11y/secrets.yaml;
        key = "personal_url";
        owner = "bdsqqq";
      };
      "axiom/personal_org_id" = {
        sopsFile = ./o11y/secrets.yaml;
        key = "personal_org_id";
        owner = "bdsqqq";
      };
      "axiom/personal_token" = {
        sopsFile = ./o11y/secrets.yaml;
        key = "personal_token";
        owner = "bdsqqq";
      };
      "axiom/papertrail_token" = {
        sopsFile = ./o11y/secrets.yaml;
        key = "papertrail_token";
        owner = "bdsqqq";
      };
      "axiom/host_metrics_token" = {
        sopsFile = ./o11y/secrets.yaml;
        key = "host_metrics_token";
        owner = "bdsqqq";
      };
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
