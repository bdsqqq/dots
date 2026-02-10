{ lib, config, pkgs, inputs, hostSystem ? null, ... }:
let
  isLinux = lib.hasInfix "linux" hostSystem;
in
/*
## programs.neovim plugin loading

plugins listed in `programs.neovim.plugins` are added to neovim's runtimepath
before init.lua runs. all configuration — options, keymaps, autocommands,
diagnostics, plugin setup() calls — lives in init.lua loaded via extraLuaConfig.

## adding plugins not in nixpkgs

```nix
plugins = [
  (pkgs.vimUtils.buildVimPlugin {
    name = "plugin-name";
    src = pkgs.fetchFromGitHub {
      owner = "user";
      repo = "repo.nvim";
      rev = "commit-hash";
      hash = "sha256-...";  # use fake hash, build will show correct one
    };
  })
];
```
*/
let
  ts-error-translator = pkgs.vimUtils.buildVimPlugin {
    name = "ts-error-translator";
    src = pkgs.fetchFromGitHub {
      owner = "dmmulroy";
      repo = "ts-error-translator.nvim";
      rev = "17ec46d9827e39ee5fab23ad6346ac7ab0fff9e4";
      hash = "sha256-jPV2DFq3rSEWzUEXqQyGRGQEmYBJPxjAoiawvwVR6LM=";
    };
  };
  vim-tpipeline = pkgs.vimUtils.buildVimPlugin {
    name = "vim-tpipeline";
    src = pkgs.fetchFromGitHub {
      owner = "vimpostor";
      repo = "vim-tpipeline";
      rev = "bc6dfc10e26a8dd1ec2f0512050a8a0afaa9d090";
      hash = "sha256-p25EBXx4lDA+7lP6LukPT/rqX/bNCliRlHs0PcOp9bo=";
    };
    nvimSkipModule = [ "tpipeline.main" ];
  };
  amp-nvim = pkgs.vimUtils.buildVimPlugin {
    name = "amp-nvim";
    src = pkgs.fetchFromGitHub {
      owner = "sourcegraph";
      repo = "amp.nvim";
      rev = "3b9ad5ef0328de1b35cc9bfa723a37db5daf9434";
      hash = "sha256-f/li32jpVigbZANnnbgSArnOH4nusj0DUz7952K+Znw=";
    };
  };
in
{
  home-manager.users.bdsqqq = { config, pkgs, lib, ... }: {
    programs.neovim = {
      enable = true;
      defaultEditor = true;
      viAlias = true;
      vimAlias = true;

      extraLuaConfig = builtins.readFile ./init.lua;

      extraPackages = with pkgs; [ stylua go lazygit ]
        ++ lib.optionals isLinux [ wl-clipboard xsel ];

      plugins = with pkgs.vimPlugins; [
        vim-tmux-navigator
        oil-nvim
        nvim-ufo
        promise-async
        vim-sleuth
        fidget-nvim
        autoclose-nvim
        lazydev-nvim
        gitsigns-nvim
        which-key-nvim
        telescope-nvim
        telescope-fzf-native-nvim
        telescope-ui-select-nvim
        nvim-lspconfig
        conform-nvim
        blink-cmp
        mini-nvim
        undotree
        nvim-treesitter.withAllGrammars
        ts-error-translator
        vim-tpipeline
        amp-nvim
      ];
    };

    home.shellAliases.v = "nvim";
  };
}
