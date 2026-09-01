{ inputs, pkgs, ... }:
{
  imports = [
    inputs.home-manager.darwinModules.home-manager

    ../../modules/nix
    ../../modules/shell/path-order.nix
    ../../modules/amp
  ];

  networking = {
    hostName = "mbp-m5.local";
    localHostName = "mbp-m5";
    computerName = "mbp-m5";
  };

  users.users.bdsqqq.home = "/Users/bdsqqq";
  system.primaryUser = "bdsqqq";

  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    extraSpecialArgs = {
      inherit inputs;
      isDarwin = true;
      hostSystem = "aarch64-darwin";
      headMode = "graphical";
    };
    users.bdsqqq = {
      home = {
        username = "bdsqqq";
        homeDirectory = "/Users/bdsqqq";
        stateVersion = "25.05";
        packages = with pkgs; [
          ast-grep
          bat
          bun
          coreutils
          curl
          deadnix
          delta
          eza
          fd
          gh
          git
          go
          httpie
          jq
          lazygit
          nil
          nixpkgs-fmt
          nodejs
          p7zip
          pnpm
          python3
          ripgrep
          statix
          tree
          wget
          yq
        ];
        sessionVariables = {
          EDITOR = "nvim";
          VISUAL = "nvim";
        };
      };

      programs = {
        direnv = {
          enable = true;
          nix-direnv.enable = true;
          config.global.hide_env_diff = true;
        };
        fzf = {
          enable = true;
          defaultCommand = "rg --files --hidden --follow";
          defaultOptions = [ "--height=40%" "--layout=reverse" ];
        };
        git = {
          enable = true;
          lfs.enable = true;
          settings = {
            init.defaultBranch = "main";
            pull.rebase = true;
            rebase.autoStash = true;
          };
        };
        home-manager.enable = true;
        neovim = {
          enable = true;
          defaultEditor = true;
          viAlias = true;
          vimAlias = true;
          withPython3 = false;
          withRuby = false;
        };
        ssh = {
          enable = true;
          enableDefaultConfig = false;
          settings."*" = {
            AddKeysToAgent = "no";
            ForwardAgent = false;
          };
        };
        zoxide = {
          enable = true;
          enableZshIntegration = true;
        };
        zsh = {
          enable = true;
          history.path = "$HOME/.zsh_history";
        };
      };
    };
  };

  system.stateVersion = 6;
  nixpkgs = {
    hostPlatform = "aarch64-darwin";
    config.allowUnfree = true;
  };
}
