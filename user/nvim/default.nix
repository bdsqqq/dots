{ lib, config, pkgs, inputs, hostSystem ? null, ... }:
let
  isLinux = lib.hasInfix "linux" hostSystem;
  p = name: src: pkgs.vimUtils.buildVimPlugin { inherit name src; doCheck = false; };
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

      plugins = [
        (p "vim-tmux-navigator" inputs.plugin-vim-tmux-navigator)
        (p "oil-nvim" inputs.plugin-oil-nvim)
        (p "nvim-ufo" inputs.plugin-nvim-ufo)
        (p "promise-async" inputs.plugin-promise-async)
        (p "vim-sleuth" inputs.plugin-vim-sleuth)
        (p "fidget-nvim" inputs.plugin-fidget-nvim)
        (p "autoclose-nvim" inputs.plugin-autoclose-nvim)
        (p "lazydev-nvim" inputs.plugin-lazydev-nvim)
        (p "gitsigns-nvim" inputs.plugin-gitsigns-nvim)
        (p "which-key-nvim" inputs.plugin-which-key-nvim)
        (p "plenary-nvim" inputs.plugin-plenary-nvim)
        (p "telescope-nvim" inputs.plugin-telescope-nvim)
        (pkgs.vimUtils.buildVimPlugin {
          name = "telescope-fzf-native-nvim";
          src = inputs.plugin-telescope-fzf-native-nvim;
          buildPhase = "make";
        })
        (p "telescope-ui-select-nvim" inputs.plugin-telescope-ui-select-nvim)
        (p "nvim-lspconfig" inputs.plugin-nvim-lspconfig)
        (p "conform-nvim" inputs.plugin-conform-nvim)
        (p "mini-nvim" inputs.plugin-mini-nvim)
        (p "undotree" inputs.plugin-undotree)
        (p "ts-error-translator" inputs.plugin-ts-error-translator)
        (pkgs.vimUtils.buildVimPlugin {
          name = "vim-tpipeline";
          src = inputs.plugin-vim-tpipeline;
          nvimSkipModule = [ "tpipeline.main" ];
        })
        (p "amp-nvim" inputs.plugin-amp-nvim)
      ] ++ (with pkgs.vimPlugins; [
        blink-cmp
        nvim-treesitter.withAllGrammars
      ]);
    };

    home.shellAliases.v = "nvim";
  };
}
