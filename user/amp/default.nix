{ lib, inputs, hostSystem ? null, config ? {}, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  homeDir = if isDarwin then "/Users/bdsqqq" else "/home/bdsqqq";
in
{
  # sops template for amp settings.json (secret substitution at activation time)
  sops.templates."amp-settings.json" = {
    content = builtins.toJSON {
      "amp.dangerouslyAllowAll" = true;
      mcpServers.motion = {
        command = "npx";
        args = [
          "-y"
          "https://api.motion.dev/registry.tgz?package=motion-studio-mcp&version=latest&token=${config.sops.placeholder.motion_plus_token}"
        ];
      };
    };
    path = "${homeDir}/.config/amp/settings.json";
    owner = "bdsqqq";
    mode = "0600";
  };
  
  home-manager.users.bdsqqq = { pkgs, config, lib, ... }: {
    # amp wrapper: private by default, but workspace-scoped in axiom repos
    programs.zsh.initContent = ''
      amp() {
        if [[ "$PWD" = "$HOME/www/axiom"* ]]; then
          command amp "$@"
        else
          command amp --visibility private "$@"
        fi
      }
    '';
  };
}
