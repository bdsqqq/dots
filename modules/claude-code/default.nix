{ config, hostSystem, lib, options, pkgs, ... }:
let
  isLinux = lib.hasSuffix "-linux" hostSystem;
  home = config.users.users.bdsqqq.home;
  tokenPath = config.sops.secrets.claude_code_oauth_token.path;
  command = "${home}/.local/bin/claude-pi";
  # only claude sees the token; launchers get just this wrapper's path.
  wrapper = pkgs.writeShellScript "claude-pi" ''
    if [ -r ${lib.escapeShellArg tokenPath} ]; then
      CLAUDE_CODE_OAUTH_TOKEN="$(<${lib.escapeShellArg tokenPath})"
      export CLAUDE_CODE_OAUTH_TOKEN
    fi
    # an api key outranks the token and would bill api credits.
    unset ANTHROPIC_API_KEY
    exec ${lib.escapeShellArg "${home}/.local/bin/claude"} "$@"
  '';
in
{
  imports = [ ./credential.nix ];

  config = lib.mkMerge [
    {
      my.claudeCode.credential.required = true;
      home-manager.users.bdsqqq.home = {
        file.".local/bin/claude-pi".source = wrapper;
        sessionVariables.PI_CLAUDE_CODE_COMMAND = command;
      };
    }
    # t3 services never see shell variables.
    (if isLinux then {
      home-manager.users.bdsqqq.home.file.".config/systemd/user/t3code.service.d/claude-code.conf".text = ''
        [Service]
        Environment=PI_CLAUDE_CODE_COMMAND=${command}
      '';
    } else lib.optionalAttrs (lib.hasAttrByPath [ "my" "t3Code" "credentialSync" "environment" ] options) {
      my.t3Code.credentialSync.environment.PI_CLAUDE_CODE_COMMAND = command;
    })
  ];
}
