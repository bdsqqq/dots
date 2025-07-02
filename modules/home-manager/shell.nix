{ config, pkgs, lib, ... }:

{
  # Ensure home directory structure exists (without overriding existing content)
  home.file = {
    "00_inbox/.keep".text = "";
    "01_files/.keep".text = "";
    "02_work/.keep".text = "";
    "03_temp/.keep".text = "";
  };

  programs = {
    zsh = {
      enable = true;
      oh-my-zsh = {
        enable = true;
        theme = "vercel";
        plugins = [ "git" ];
        custom = "$HOME/.config/zsh/oh-my-zsh-custom";
      };
      plugins = [
        {
          name = "zsh-autosuggestions";
          src = pkgs.fetchFromGitHub {
            owner = "zsh-users";
            repo = "zsh-autosuggestions";
            rev = "v0.7.0";
            sha256 = "1g3pij5qn2j7v7jjac2a63lxd97mcsgw6xq6k5p7835q9fjiid98";
          };
        }
      ];
      shellAliases = {
        # Add your custom aliases here
      };
    };
    nushell = {
      enable = true;
      # Environment variables using the correct Home Manager structure
      extraEnv = ''
        # Environment variables matching zsh setup
        $env.BUN_INSTALL = ($env.HOME | path join ".bun")
        $env.GOPATH = ($env.HOME | path join "go")
        $env.PIP_USER = "true"
        $env.PNPM_HOME = ($env.HOME | path join "Library" "pnpm")
        $env.PYTHONDONTWRITEBYTECODE = "1"
        $env.PYTHONPATH = ($env.HOME | path join ".local" "lib" "python3.12" "site-packages")
        $env.PYTHONUNBUFFERED = "1"
        $env.SDKMAN_DIR = ($env.HOME | path join ".sdkman")
        $env.POETRY_VENV_IN_PROJECT = "true"
        
        # Load Anthropic API key from sops or fallback to existing env var
        $env.ANTHROPIC_API_KEY = (try { 
          open ($env.HOME | path join ".config" "sops-nix" "secrets" "anthropic_api_key") 
        } catch { 
          $env.ANTHROPIC_API_KEY? | default "" 
        })
        
        # PATH configuration matching zsh setup
        $env.PATH = ($env.PATH | split row (char esep) | prepend [
          "/etc/profiles/per-user/bdsqqq/bin"
          ($env.HOME | path join ".nix-profile" "bin")
          ($env.GOPATH | path join "bin")
          ($env.HOME | path join ".scripts")
          $env.PNPM_HOME
          ($env.BUN_INSTALL | path join "bin")
          ($env.HOME | path join ".local" "bin")
        ])
        
        # Brew environment - load if available
        if ("/opt/homebrew/bin/brew" | path exists) {
          # Note: brew shellenv output needs to be processed for nushell
          $env.HOMEBREW_PREFIX = "/opt/homebrew"
          $env.HOMEBREW_CELLAR = "/opt/homebrew/Cellar"
          $env.HOMEBREW_REPOSITORY = "/opt/homebrew"
          $env.PATH = ($env.PATH | prepend "/opt/homebrew/bin" | prepend "/opt/homebrew/sbin")
        }
        
        # FNM environment
        if (which fnm | is-not-empty) {
          $env.FNM_ARCH = "arm64"
          $env.FNM_NODE_DIST_MIRROR = "https://nodejs.org/dist"
        }
        
        # Java/SDKMAN environment
        if ($env.SDKMAN_DIR | path join "candidates" "java" "current" | path exists) {
          $env.JAVA_HOME = ($env.SDKMAN_DIR | path join "candidates" "java" "current")
        }
        
        # FZF integration
        if (which fzf | is-not-empty) {
          $env.FZF_DEFAULT_OPTS = "--height 40% --reverse --border"
        }
      '';
      extraConfig = ''
        # Nushell Configuration
        
        # History configuration matching zsh setup
        $env.config = {
          history: {
            max_size: 10000
            sync_on_enter: true
            file_format: "plaintext"
            isolation: false
          }
          completions: {
            case_sensitive: false
            quick: true
            partial: true
            algorithm: "prefix"
          }
          table: {
            mode: rounded
          }
          show_banner: false
        }
        
        # Initialize external tools that need dynamic setup
        # FNM (Node version manager) - dynamic environment loading
        if (which fnm | is-not-empty) {
          # Load fnm environment dynamically
          try {
            ^fnm env --json | from json | load-env
          } catch {
            # Fallback if fnm env fails
          }
          
          # Add fnm hook for directory changes
          $env.config = ($env.config | upsert hooks {
            pre_prompt: [
              {
                code: "
                  if ('.nvmrc' | path exists) or ('.node-version' | path exists) {
                    try { ^fnm use } catch { |e| # silently fail }
                  }
                "
              }
            ]
          })
        }
      '';
      shellAliases = {
        # Python aliases matching zsh setup
        venv = "python3 -m venv";
        # Note: nushell doesn't have 'source' command, use overlay instead
        activate = "overlay use venv/bin/activate.nu";
        py = "python3";
        pip3 = "python3 -m pip";
        # Additional nushell-friendly aliases
        ll = "ls -la";
        la = "ls -la";
      };
      # Login configuration to ensure Nix environment loads properly when nu is default shell
      extraLogin = ''
        # Source Home Manager session variables for proper Nix environment
        # This is crucial when Nushell is set as the default shell on macOS
        if ("/etc/profiles/per-user/bdsqqq/etc/profile.d/hm-session-vars.sh" | path exists) {
          # Load Home Manager session variables
          # Note: This requires parsing the bash/sh script for nushell
          let hm_vars = (^sh -c "source /etc/profiles/per-user/bdsqqq/etc/profile.d/hm-session-vars.sh && env" | lines | each { |line| $line | parse "{key}={value}" } | flatten | where key != "" | reduce -f {} { |row, acc| $acc | upsert $row.key $row.value })
          load-env $hm_vars
        }
        
        # Also try the alternative location
        if (($env.HOME | path join ".nix-profile" "etc" "profile.d" "hm-session-vars.sh") | path exists) {
          let hm_vars_alt = (^sh -c ("source " + ($env.HOME | path join ".nix-profile" "etc" "profile.d" "hm-session-vars.sh") + " && env") | lines | each { |line| $line | parse "{key}={value}" } | flatten | where key != "" | reduce -f {} { |row, acc| $acc | upsert $row.key $row.value })
          load-env $hm_vars_alt
        }
      '';
    };
    fzf = {
      enable = true;
      enableZshIntegration = true;
    };
  };

  # Custom files
  home.file.".config/zsh/oh-my-zsh-custom/themes/vercel.zsh-theme".text = ''
    local resetColor="%{$reset_color%}"
    local logo="%{$fg_bold[white]%}△$resetColor$resetColor"
    local hostname=`hostname`
    local dir="%{$fg_bold[white]%}%c$resetColor$resetColor"
    local inputIndicator=" %{$fg_bold[White]%}↳ $resetColor"

    GIT_PROMPT_PREFIX="[%{$fg_bold[white]%}"
    GIT_PROMPT_SUFFIX="$resetColor]"
    GIT_PROMPT_DIRTY="%{$fg_bold[lightWhite]%}"
    GIT_PROMPT_CLEAN="%{$fg_bold[darkWhite]%}"

    # modified from https://github.com/robbyrussell/oh-my-zsh/blob/576ada138fc5eed3f58a4aff8141e483310c90fb/lib/git.zsh#L12
    function branch_is_dirty() {
      local STATUS=""
      local -a FLAGS
      FLAGS=('--porcelain')
      if [[ "$(command git config --get oh-my-zsh.hide-dirty)" != "1" ]]; then
        if [[ $POST_1_7_2_GIT -gt 0 ]]; then
          FLAGS+='--ignore-submodules=dirty'
        fi
        if [[ "$DISABLE_UNTRACKED_FILES_DIRTY" == "true" ]]; then
          FLAGS+='--untracked-files=no'
        fi
        STATUS=$(command git status ''${FLAGS} 2> /dev/null | tail -n1)
      fi
      if [[ -n $STATUS ]]; then
        return 0
      else
        return 1
      fi
    }

    function git_prompt() {
      branch=`git_current_branch`
      if [ "$branch" = "" ]; then
        # not a git repo
        echo ""
      else
        if branch_is_dirty; then
          echo "$GIT_PROMPT_PREFIX$GIT_PROMPT_DIRTY$branch$GIT_PROMPT_SUFFIX"
        else
          echo "$GIT_PROMPT_PREFIX$GIT_PROMPT_CLEAN$branch$GIT_PROMPT_SUFFIX"
        fi
      fi
    }
    NEWLINE=$'\n '

    PROMPT='$logo $dir $(git_prompt) $NEWLINE $inputIndicator'
  '';
}
