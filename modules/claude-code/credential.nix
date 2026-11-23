{ config, lib, ... }:
let
  cfg = config.my.claudeCode.credential;
in
{
  options.my.claudeCode.credential.required =
    lib.mkEnableOption "the shared Claude subscription token for pi-claude-code";

  config = lib.mkIf cfg.required {
    sops.secrets.claude_code_oauth_token = {
      sopsFile = ./secrets.yaml;
      owner = "bdsqqq";
      mode = "0400";
    };
  };
}
