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
        # reject dangerous git operations
        { tool = "Bash"; matches = { cmd = [ "*git add -A*" "*git add .*" ]; }; action = "reject"; 
          message = "stage files explicitly with 'git add <file>' — unstaged changes may not be yours"; }
        { tool = "Bash"; matches = { cmd = [ "*git push --force*" "*git push -f*" "*--force-with-lease*" ]; }; action = "reject";
          message = "never force push. if diverged: 'git fetch origin && git rebase origin/main && git push'"; }
        
        # prefer trash over rm (but allow subcommands like 'wt rm', 'git worktree remove')
        { tool = "Bash"; matches = { cmd = [ "rm *" "* && rm *" "* || rm *" "* ; rm *" ]; }; action = "reject";
          message = "use 'trash <file>' instead of rm — recoverable deletion"; }
        
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
    owner = "bdsqqq";
    mode = "0600";
  };
  
  home-manager.users.bdsqqq = { pkgs, config, lib, ... }: {
    home.file.".config/amp/settings.json".source = config.lib.file.mkOutOfStoreSymlink "/run/secrets/rendered/amp-settings.json";

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
