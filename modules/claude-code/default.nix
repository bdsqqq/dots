{ config, hostSystem, lib, options, pkgs, ... }:
let
  isLinux = lib.hasSuffix "-linux" hostSystem;
  home = config.users.users.bdsqqq.home;
  tokenPath = config.sops.secrets.claude_code_oauth_token.path;
  command = "${home}/.local/bin/claude-pi";
  # Only Claude processes see the token: Pi and shells never export it.
  # A missing secret falls back to the host's own `claude` login.
  wrapper = pkgs.writeShellScript "claude-pi" ''
    if [ -r ${lib.escapeShellArg tokenPath} ]; then
      CLAUDE_CODE_OAUTH_TOKEN="$(<${lib.escapeShellArg tokenPath})"
      export CLAUDE_CODE_OAUTH_TOKEN
    fi
    # An API key outranks the token in Claude Code; never bill API quota.
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
        # pi-claude-code reads this from the environment of whatever launches pi.
        sessionVariables.PI_CLAUDE_CODE_COMMAND = command;
      };
    }
    (if isLinux then {
      # T3 runs pi as a systemd user service, which never sees shell variables.
      home-manager.users.bdsqqq.home.file.".config/systemd/user/t3code.service.d/claude-code.conf".text = ''
        [Service]
        Environment=PI_CLAUDE_CODE_COMMAND=${command}
      '';
    } else lib.optionalAttrs (lib.hasAttrByPath [ "my" "t3Code" "credentialSync" "environment" ] options) {
      # T3's LaunchAgent never sees shell variables; its launcher reads service.env.
      my.t3Code.credentialSync.environment.PI_CLAUDE_CODE_COMMAND = command;
    })
  ];
}
