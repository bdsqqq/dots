{ lib, inputs, hostSystem ? null, config ? {}, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  homeDir = if isDarwin then "/Users/bdsqqq" else "/home/bdsqqq";
in
{
  # sops template for amp settings.json (secret substitution at activation time)
  sops.templates."amp-settings.json" = {
    content = builtins.toJSON {
      "amp.permissions" = [
        # blacklist: reject dangerous git operations
        { tool = "Bash"; matches = { cmd = "*git add -A*"; }; action = "reject"; 
          message = "stage files explicitly with 'git add <file>' — unstaged changes may not be yours"; }
        { tool = "Bash"; matches = { cmd = "*git add .*"; }; action = "reject";
          message = "stage files explicitly with 'git add <file>' — unstaged changes may not be yours"; }
        { tool = "Bash"; matches = { cmd = "*git push --force*"; }; action = "reject";
          message = "never force push. if diverged: 'git fetch origin && git rebase origin/main && git push'"; }
        { tool = "Bash"; matches = { cmd = "*git push -f*"; }; action = "reject";
          message = "never force push. if diverged: 'git fetch origin && git rebase origin/main && git push'"; }
        { tool = "Bash"; matches = { cmd = "*--force-with-lease*"; }; action = "reject";
          message = "never force push (including --force-with-lease). if diverged: 'git fetch origin && git rebase origin/main && git push'"; }
        
        # allow everything else
        { tool = "*"; action = "allow"; }
      ];
      
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
