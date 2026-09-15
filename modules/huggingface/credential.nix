{ config, lib, ... }:
let
  cfg = config.my.huggingface.credential;
in
{
  options.my.huggingface.credential.required =
    lib.mkEnableOption "the Hugging Face API credential";

  config = lib.mkIf cfg.required {
    sops.secrets.hf_token = {
      sopsFile = ./secrets.yaml;
      owner = "bdsqqq";
      mode = "0400";
    };
  };
}
