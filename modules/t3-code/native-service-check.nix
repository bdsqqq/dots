{ config, lib }:
let
  dropIn = config.home-manager.users.bdsqqq.home.file.".config/systemd/user/t3code.service.d/nix.conf".text;
  environment = config.sops.templates.t3-code-environment;
in
assert config.my.t3Code.nativeService.enable;
assert !(config.systemd.services ? t3-code);
assert config.users.users.bdsqqq.linger;
# The installer/updater owns ExecStart and the selected runtime, not Nix.
assert !(lib.hasInfix "ExecStart" dropIn);
assert lib.hasInfix "Environment=T3CODE_HOST=127.0.0.1" dropIn;
assert lib.hasInfix "Environment=T3CODE_PORT=3773" dropIn;
assert lib.hasInfix "EnvironmentFile=${environment.path}" dropIn;
assert lib.hasInfix "${config.home-manager.users.bdsqqq.home.profileDirectory}/bin" dropIn;
assert environment.owner == "bdsqqq";
assert environment.mode == "0400";
assert lib.all
  (name: lib.hasInfix config.sops.placeholder.${name} environment.content)
  [ "gh_token" "hf_token" "parallel_api_key" "artificial_analysis_api_key" ];
true
