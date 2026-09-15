{ config, lib, ... }:
let
  parallelApiKeyPath = config.sops.secrets.parallel_api_key.path;
in
{
  sops.secrets.parallel_api_key = {
    sopsFile = ./secrets.yaml;
    owner = "bdsqqq";
    mode = "0400";
  };

  home-manager.users.bdsqqq = {
    programs.zsh.initContent = lib.mkAfter ''
      export PARALLEL_API_KEY="$(cat ${parallelApiKeyPath} 2>/dev/null || echo "$PARALLEL_API_KEY")"
    '';
  };
}
