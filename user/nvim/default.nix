{ lib, config, pkgs, inputs, hostSystem ? null, ... }:
let
  isLinux = lib.hasInfix "linux" hostSystem;
in
/*
## nixvim plugin loading order

plugins in extraPlugins are added to neovim's runtimepath before any lua config runs.
they're available in all three config sections:

- **extraConfigLuaPre**: vim options, highlights, diagnostics. runs first.
- **extraConfigLua**: plugin setup() calls. standard location.
- **extraConfigLuaPost**: autocommands, post-setup config. runs last.

use extraConfigLua for setup() calls, not extraConfigLuaPre.

## adding plugins not in nixpkgs

```nix
extraPlugins = [(pkgs.vimUtils.buildVimPlugin {
  name = "plugin-name";
  src = pkgs.fetchFromGitHub {
    owner = "user";
    repo = "repo.nvim";
    rev = "commit-hash";
    hash = "sha256-...";  # use fake hash, build will show correct one
  };
})];

extraConfigLua = ''
  require('plugin-name').setup({})
'';
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
    imports = [ inputs.nixvim.homeModules.nixvim ];
    programs.nixvim = {
      enable = true;
      extraPlugins = [ ts-error-translator vim-tpipeline amp-nvim ];
      extraConfigLua = builtins.readFile ./config.lua;

      globals = { 
        mapleader = " "; maplocalleader = " "; have_nerd_font = true;
        # tpipeline renders nvim statusline into tmux status bar
        tpipeline_autoembed = 0;
        tpipeline_fillchar = " ";
      };
      clipboard = { 
        providers = { 
          wl-copy.enable = isLinux;
          xsel.enable = isLinux;
        }; 
        register = "unnamedplus"; 
      };
      opts = {
        number = true; mouse = "a"; showmode = false; laststatus = 0; ruler = false; cmdheight = 0;
        breakindent = true; undofile = true; ignorecase = true; smartcase = true; signcolumn = "yes"; updatetime = 250;
        timeoutlen = 300; splitright = true; splitbelow = true; list = true; listchars.__raw = "{ tab = '» ', trail = '·', nbsp = '␣',   }";
        inccommand = "split"; cursorline = false; scrolloff = 10; confirm = true; hlsearch = true;
        foldcolumn = "0"; foldlevel = 99; foldlevelstart = 99; foldenable = true;
        statuscolumn = "%{foldclosed(v:lnum) > 0 ? '>  ' : ''}%{foldclosed(v:lnum) == -1 ? v:lnum . ' ' : ''}";
      };

      keymaps = [
        { mode = "n"; key = "<Esc>"; action = "<cmd>nohlsearch<CR>"; }
        { mode = "t"; key = "<Esc><Esc>"; action = "<C-\\><C-n>"; options.desc = "exit terminal mode"; }
        { mode = "n"; key = "<C-h>"; action = "<cmd>TmuxNavigateLeft<CR>";  options.desc = "move pane focus left"; }
        { mode = "n"; key = "<C-l>"; action = "<cmd>TmuxNavigateRight<CR>"; options.desc = "move pane focus right"; }
        { mode = "n"; key = "<C-j>"; action = "<cmd>TmuxNavigateDown<CR>";  options.desc = "move pane focus down"; }
        { mode = "n"; key = "<C-k>"; action = "<cmd>TmuxNavigateUp<CR>";    options.desc = "move pane focus up"; }
        { mode = "n"; key = "<C-\\>"; action = "<cmd>TmuxNavigatePrevious<CR>"; options.desc = "move pane focus previous"; }
        # ctrl+/ sends 0x1F (ctrl+_) in terminals — legacy encoding quirk
        { mode = "n"; key = "<C-_>"; action = "gcc"; options.desc = "toggle comment"; options.remap = true; }
        { mode = "v"; key = "<C-_>"; action = "gcgv"; options.desc = "toggle comment"; options.remap = true; }
        { mode = ""; key = "<leader>f"; action.__raw = ''function() require('conform').format { async = true, lsp_fallback = true } end''; options.desc = "[f]ormat buffer"; }
        { mode = "n"; key = "<leader>/"; action.__raw = ''function() require('telescope.builtin').current_buffer_fuzzy_find(require('telescope.themes').get_dropdown { winblend = 10, previewer = false }) end''; options.desc = "[/] fuzzily search in current buffer"; }
        { mode = "n"; key = "<leader>s/"; action.__raw = ''function() require('telescope.builtin').live_grep { grep_open_files = true, prompt_title = 'Live Grep in Open Files' } end''; options.desc = "[s]earch [/] in open files"; }
        { mode = "n"; key = "<leader>sn"; action.__raw = ''function() require('telescope.builtin').find_files { cwd = vim.fn.stdpath 'config' } end''; options.desc = "[s]earch [n]eovim files"; }
        { mode = "n"; key = "<leader>tf"; action.__raw = ''function() local ok, mini_files = pcall(require, 'mini.files'); if ok then mini_files.open() else vim.cmd('Explore') end end''; options.desc = "[t]oggle [f]iles"; }
        { mode = "n"; key = "<leader>tu"; action = "<cmd>UndotreeToggle<CR>"; options.desc = "[t]oggle [u]ndo tree"; }
        { mode = "n"; key = "<leader>to"; action.__raw = ''function() require('oil').open() end''; options.desc = "[t]oggle [o]il"; }
        { mode = "n"; key = "<leader>sb"; action.__raw = ''function() require('telescope.builtin').buffers() end''; options.desc = "[s]earch [b]uffers"; }
        { mode = "n"; key = "<leader>tw"; action = "<cmd>set wrap!<CR>"; options.desc = "[t]oggle [w]ord wrap"; }
        { mode = "n"; key = "<leader>tl"; action.__raw = ''function() local enabled = vim.diagnostic.is_enabled(); vim.diagnostic.enable(not enabled); vim.notify("Diagnostics " .. (enabled and "disabled" or "enabled")) end''; options.desc = "[t]oggle [l]sp diagnostics"; }
        { mode = "n"; key = "<leader>tn"; action = "<cmd>set nu!<CR>"; options.desc = "[t]oggle line [n]umbers"; }
        { mode = "n"; key = "<leader>tr"; action = "<cmd>set rnu!<CR>"; options.desc = "[t]oggle [r]elative numbers"; }
        { mode = "n"; key = "<leader>tg"; action.__raw = ''function() _G.open_floating_term('lazygit') end''; options.desc = "[t]oggle [g]it (lazygit)"; }
        { mode = "n"; key = "<Left>"; action.__raw = ''function() if vim.fn.col('.') == 1 then vim.cmd('normal! za') else vim.cmd('normal! h') end end''; options.desc = "toggle fold at first column, otherwise move left"; }
        { mode = "n"; key = "h"; action.__raw = ''function() if vim.fn.col('.') == 1 then vim.cmd('normal! za') else vim.cmd('normal! h') end end''; options.desc = "toggle fold at first column, otherwise move left"; }
      ];

      autoGroups = { kickstart-highlight-yank.clear = true; kickstart-lsp-attach.clear = true; };
      autoCmd = [
        { event = [ "TextYankPost" ]; desc = "highlight when yanking (copying) text"; group = "kickstart-highlight-yank"; callback.__raw = ''function() vim.highlight.on_yank() end''; }
      ];

      diagnostic.settings = {
        severity_sort = true; float = { border = "rounded"; source = "if_many"; };
        underline.severity = [ "ERROR" ];
        signs.text = { ERROR = "✘"; WARN = "⚠"; INFO = "ℹ"; HINT = "⚑"; };
        virtual_text = { source = "if_many"; spacing = 2; };
      };

      extraPackages = with pkgs; [ stylua go lazygit ];

      plugins = {
        tmux-navigator.enable = true;
        # zellij-nav for seamless nvim+zellij navigation (alternative to tmux-navigator)
        # tmux-navigator also works with zellij via MoveFocusOrTab
        oil.enable = true;
        oil.settings = { default_file_explorer = true; delete_to_trash = true; skip_confirm_for_simple_edits = true; view_options.show_hidden = true; };

        nvim-ufo.enable = true;
        nvim-ufo.settings.provider_selector = ''_G.ufo_provider_selector'';
        nvim-ufo.settings.fold_virt_text_handler = ''_G.ufo_fold_virt_text_handler'';

        sleuth.enable = true;
        fidget.enable = true;
        autoclose.enable = true;
        lazydev.enable = true;
        lazydev.settings.library = [{ path = "\${3rd}/luv/library"; words = [ "vim%.uv" ]; }];

        gitsigns.enable = true;
        gitsigns.settings = {
          signs.add.text = "+"; signs.change.text = "~"; signs.delete.text = "_"; signs.topdelete.text = "‾"; signs.changedelete.text = "~";
          on_attach.__raw = ''_G.gitsigns_on_attach'';
        };

        which-key.enable = true;
        which-key.settings.spec = [
          {
            __unkeyed-1 = "<leader>s";
            group = "[s]earch";
          }
          {
            __unkeyed-1 = "<leader>t";
            group = "[t]oggle";
          }
          {
            __unkeyed-1 = "<leader>h";
            group = "git [h]unk";
            mode = [ "n" "v" ];
          }
          {
            __unkeyed-1 = "<leader>l";
            group = "[l]sp";
          }
        ];

        telescope.enable = true;
        telescope.extensions.fzf-native.enable = true; telescope.extensions.ui-select.enable = true;
        telescope.keymaps = {
          "<leader>sh" = { mode = "n"; action = "help_tags"; options.desc = "[s]earch [h]elp"; };
          "<leader>sk" = { mode = "n"; action = "keymaps"; options.desc = "[s]earch [k]eymaps"; };
          "<leader>sf" = { mode = "n"; action = "find_files"; options.desc = "[s]earch [f]iles"; };
          "<leader>ss" = { mode = "n"; action = "builtin"; options.desc = "[s]earch [s]elect telescope"; };
          "<leader>sw" = { mode = "n"; action = "grep_string"; options.desc = "[s]earch current [w]ord"; };
          "<leader>sg" = { mode = "n"; action = "live_grep"; options.desc = "[s]earch by [g]rep"; };
          "<leader>sd" = { mode = "n"; action = "diagnostics"; options.desc = "[s]earch [d]iagnostics"; };
          "<leader>sr" = { mode = "n"; action = "resume"; options.desc = "[s]earch [r]esume"; };
          "<leader>s." = { mode = "n"; action = "oldfiles"; options.desc = "[s]earch recent files ('.' for repeat)"; };
          "<leader><leader>" = { mode = "n"; action = "buffers"; options.desc = "[ ] find existing buffers"; };
        };
        telescope.settings = { defaults.file_ignore_patterns = {}; defaults.hidden = true; pickers.find_files.hidden = true; extensions.__raw = "{ ['ui-select'] = { require('telescope.themes').get_dropdown() } }"; };

        lsp.enable = true;
        lsp.servers.lua_ls.enable = true; lsp.servers.lua_ls.settings.completion.callSnippet = "Replace";
        lsp.servers.ts_ls.enable = true; lsp.servers.gopls.enable = true;
        lsp.keymaps.extra = [
          { mode = "n"; key = "gd"; action.__raw = ''function() local ok, t = pcall(require, 'telescope.builtin'); if ok then t.lsp_definitions() else vim.lsp.buf.definition() end end''; options.desc = "lsp: [g]oto [d]efinition"; }
          { mode = "n"; key = "gr"; action.__raw = ''function() local ok, t = pcall(require, 'telescope.builtin'); if ok then t.lsp_references() else vim.lsp.buf.references() end end''; options.desc = "lsp: [g]oto [r]eferences"; }
          { mode = "n"; key = "gi"; action.__raw = ''function() local ok, t = pcall(require, 'telescope.builtin'); if ok then t.lsp_implementations() else vim.lsp.buf.implementation() end end''; options.desc = "lsp: [g]oto [i]mplementation"; }
          { mode = "n"; key = "gt"; action.__raw = ''function() local ok, t = pcall(require, 'telescope.builtin'); if ok then t.lsp_type_definitions() else vim.lsp.buf.type_definition() end end''; options.desc = "lsp: [g]oto [t]ype definition"; }
          { mode = "n"; key = "gO"; action.__raw = ''function() local ok, t = pcall(require, 'telescope.builtin'); if ok then t.lsp_document_symbols() else vim.lsp.buf.document_symbol() end end''; options.desc = "lsp: open document symbols"; }
          { mode = "n"; key = "gW"; action.__raw = ''function() local ok, t = pcall(require, 'telescope.builtin'); if ok then t.lsp_dynamic_workspace_symbols() else vim.lsp.buf.workspace_symbol() end end''; options.desc = "lsp: open workspace symbols"; }
          { mode = "n"; key = "<leader>ld"; action.__raw = ''function() local ok, t = pcall(require, 'telescope.builtin'); if ok then t.lsp_definitions() else vim.lsp.buf.definition() end end''; options.desc = "lsp: goto [d]efinition"; }
          { mode = "n"; key = "<leader>lr"; action.__raw = ''function() local ok, t = pcall(require, 'telescope.builtin'); if ok then t.lsp_references() else vim.lsp.buf.references() end end''; options.desc = "lsp: goto [r]eferences (find usages)"; }
          { mode = "n"; key = "<leader>li"; action.__raw = ''function() local ok, t = pcall(require, 'telescope.builtin'); if ok then t.lsp_implementations() else vim.lsp.buf.implementation() end end''; options.desc = "lsp: goto [i]mplementation"; }
          { mode = "n"; key = "<leader>lt"; action.__raw = ''function() local ok, t = pcall(require, 'telescope.builtin'); if ok then t.lsp_type_definitions() else vim.lsp.buf.type_definition() end end''; options.desc = "lsp: goto [t]ype definition"; }
          { mode = "n"; key = "<leader>ls"; action.__raw = ''function() local ok, t = pcall(require, 'telescope.builtin'); if ok then t.lsp_dynamic_workspace_symbols() else vim.lsp.buf.workspace_symbol() end end''; options.desc = "lsp: workspace [s]ymbols"; }
          { mode = "n"; key = "<leader>lq"; action.__raw = "vim.diagnostic.setloclist"; options.desc = "lsp: diagnostic [q]uickfix list"; }
        ];
        lsp.keymaps.lspBuf = {
          "<leader>ln" = { mode = "n"; action = "rename"; desc = "lsp: re[n]ame symbol"; };
          "<leader>la" = { mode = [ "n" "x" ]; action = "code_action"; desc = "lsp: code [a]ctions"; };
          "<leader>lD" = { mode = "n"; action = "declaration"; desc = "lsp: goto [D]eclaration"; };
          "<leader>lh" = { mode = "n"; action = "hover"; desc = "lsp: [h]over documentation"; };
          "K" = { mode = "n"; action = "hover"; desc = "hover documentation"; };
        };

        conform-nvim.enable = true;
        conform-nvim.settings.notify_on_error = false;
        conform-nvim.settings.format_on_save = ''
          function(bufnr)
            local disable_filetypes = { c = true, cpp = true }
            return {
              timeout_ms = 500,
              lsp_fallback = not disable_filetypes[vim.bo[bufnr].filetype],
              quiet = true
            }
          end
        '';
        conform-nvim.settings.formatters = {
          biome.condition.__raw = ''function() return vim.fn.executable("biome") == 1 end'';
          gofmt.condition.__raw = ''function() return vim.fn.executable("gofmt") == 1 end'';
        };
        conform-nvim.settings.formatters_by_ft = { lua = [ "stylua" ]; javascript = [ "biome" ]; typescript = [ "biome" ]; javascriptreact = [ "biome" ]; typescriptreact = [ "biome" ]; json = [ "biome" ]; go = [ "gofmt" ]; };

        blink-cmp.enable = true;
        blink-cmp.settings.keymap = { preset = "default"; "<Tab>" = [ "snippet_forward" "fallback" ]; "<S-Tab>" = [ "snippet_backward" "fallback" ]; "<CR>" = [ "accept" "fallback" ]; "<Down>" = [ "select_next" "fallback" ]; "<Up>" = [ "select_prev" "fallback" ]; "<Esc>" = [ "hide" "fallback" ]; };
        blink-cmp.settings.appearance.nerd_font_variant = "mono";
        blink-cmp.settings.completion = { documentation.auto_show = true; documentation.auto_show_delay_ms = 500; ghost_text.enabled = true; menu.auto_show = true; menu.draw.treesitter = [ "lsp" ]; };
        blink-cmp.settings.sources.default = [ "lsp" "path" "snippets" "buffer" ];
        blink-cmp.settings.sources.providers.lazydev = { name = "LazyDev"; module = "lazydev.integrations.blink"; score_offset = 100; };
        blink-cmp.settings.snippets.preset = "default"; blink-cmp.settings.signature.enabled = true;

        mini.enable = true;
        mini.modules.icons = {}; mini.modules.surround = {}; mini.modules.comment = {};
        mini.modules.files.options.permanent_delete = true; mini.modules.files.options.use_as_default_explorer = true;
        mini.modules.files.content.filter.__raw = ''function(fs_entry) return true end'';
        mini.mockDevIcons = true;

        undotree.enable = true; undotree.settings = { FloatDiff = true; FocusOnToggle = true; };

        treesitter.enable = true;
        treesitter.settings.ensureInstalled = [ "bash" "diff" "html" "lua" "luadoc" "markdown" "markdown_inline" "query" "vim" "vimdoc" "nix" "javascript" "typescript" "jsx" "tsx" "json" "jsonc" "python" "regex" "go" ];
        treesitter.settings.highlight.enable = true; treesitter.settings.highlight.additional_vim_regex_highlighting = true;
        treesitter.settings.indent.enable = true; treesitter.settings.indent.disable = [ "ruby" ];
      };
    };

    home.shellAliases.v = "nvim";
  };
}


