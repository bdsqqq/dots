{ lib, config, pkgs, inputs, ... }:
{
  home-manager.users.bdsqqq = { config, pkgs, lib, ... }: {
    imports = [ inputs.nixvim.homeManagerModules.nixvim ];
    programs.nixvim = {
      enable = true;
      extraPlugins = [ ];
      extraConfigLuaPre = ''
        -- use default colorscheme (vesper completely removed)
        vim.cmd.colorscheme('default')

        -- floating terminal function
        local function open_floating_term(cmd)
          local columns = vim.api.nvim_get_option("columns")
          local lines = vim.api.nvim_get_option("lines")

          local width = math.floor(columns * 0.8)
          local height = math.floor(lines * 0.8)
          if width < 60 then width = columns end
          if height < 20 then height = lines end
          local row = math.floor((lines - height) / 2)
          local col = math.floor((columns - width) / 2)

          local buf = vim.api.nvim_create_buf(false, true)
          local opts = {
            style = "minimal",
            relative = "editor",
            width = width,
            height = height,
            row = row,
            col = col,
            border = "rounded",
          }
          local win = vim.api.nvim_open_win(buf, true, opts)

          vim.fn.termopen(cmd, {
            on_exit = function()
              if vim.api.nvim_win_is_valid(win) then
                vim.api.nvim_win_close(win, true)
              end
              if vim.api.nvim_buf_is_valid(buf) then
                vim.api.nvim_buf_delete(buf, {force=true})
              end
            end
          })
          vim.cmd("startinsert")
        end

        _G.open_floating_term = open_floating_term
        _G.MyFoldText = function() return vim.fn.foldtext() end

        vim.api.nvim_create_autocmd('ColorScheme', {
          callback = function()
            local comment_hl = vim.api.nvim_get_hl(0, { name = 'Comment' })
            vim.api.nvim_set_hl(0, 'FoldColumn', { fg = comment_hl.fg })
          end
        })

        vim.defer_fn(function()
          local comment_hl = vim.api.nvim_get_hl(0, { name = 'Comment' })
          vim.api.nvim_set_hl(0, 'FoldColumn', { fg = comment_hl.fg })
          vim.api.nvim_set_hl(0, 'Normal', { bg = 'NONE', ctermbg = 'NONE' })
          vim.api.nvim_set_hl(0, 'NormalFloat', { bg = 'NONE', ctermbg = 'NONE' })
          vim.api.nvim_set_hl(0, 'SignColumn', { bg = 'NONE', ctermbg = 'NONE' })
          vim.api.nvim_set_hl(0, 'LineNr', { bg = 'NONE', ctermbg = 'NONE' })
          vim.api.nvim_set_hl(0, 'NonText', { bg = 'NONE', ctermbg = 'NONE' })
          vim.api.nvim_set_hl(0, 'EndOfBuffer', { bg = 'NONE', ctermbg = 'NONE' })
          vim.opt.winblend = 0
          vim.opt.pumblend = 0
          vim.api.nvim_set_hl(0, 'Terminal', { bg = 'NONE', ctermbg = 'NONE' })
        end, 100)

        _G.Statusline = function()
          local file = vim.fn.expand("%:t")
          if file == "" then
            file = "[No Name]"
          end

          local branch = ""
          local git = vim.b.gitsigns_status_dict
          if git and git.head and git.head ~= "" then
            branch = string.format("[%s]", git.head)
          end

          local dirty = vim.bo.modified and "*" or ""
          return string.format("%s%s%s", branch, file, dirty)
        end

        -- statusline sent to zellij, not shown in nvim
        vim.o.laststatus = 0
      '';

      globals = { mapleader = " "; maplocalleader = " "; have_nerd_font = true; };
      clipboard = { providers = { wl-copy.enable = true; xsel.enable = true; }; register = "unnamedplus"; };
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

      autoGroups = { kickstart-highlight-yank.clear = true; kickstart-lsp-attach.clear = true; zellij-statusline.clear = true; };
      autoCmd = [
        { event = [ "TextYankPost" ]; desc = "highlight when yanking (copying) text"; group = "kickstart-highlight-yank"; callback.__raw = ''function() vim.highlight.on_yank() end''; }
        { 
          event = [ "BufEnter" "BufWritePost" "TextChanged" "TextChangedI" ]; 
          desc = "send statusline to zellij"; 
          group = "zellij-statusline"; 
          callback.__raw = ''
            function()
              if vim.env.ZELLIJ then
                local status = Statusline()
                vim.fn.system("zellij pipe 'zjstatus::pipe::pipe_nvim_status::" .. status .. "'")
              end
            end
          ''; 
        }
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
        nvim-ufo.settings.provider_selector = ''
          function(bufnr, filetype, buftype)
            return {'treesitter', 'indent'}
          end
        '';
        nvim-ufo.settings.fold_virt_text_handler = ''
          function(virtText, lnum, endLnum, width, truncate)
            local newVirtText = {}
            local curWidth = 0
            for _, chunk in ipairs(virtText) do
              local chunkText = chunk[1]
              local chunkWidth = vim.fn.strdisplaywidth(chunkText)
              if width > curWidth + chunkWidth then
                table.insert(newVirtText, chunk)
              else
                chunkText = truncate(chunkText, width - curWidth)
                local hlGroup = chunk[2]
                table.insert(newVirtText, {chunkText, hlGroup})
                break
              end
              curWidth = curWidth + chunkWidth
            end
            return newVirtText
          end
        '';

        sleuth.enable = true;
        fidget.enable = true;
        autoclose.enable = true;
        lazydev.enable = true;
        lazydev.settings.library = [{ path = "\${3rd}/luv/library"; words = [ "vim%.uv" ]; }];

        gitsigns.enable = true;
        gitsigns.settings = {
          signs.add.text = "+"; signs.change.text = "~"; signs.delete.text = "_"; signs.topdelete.text = "‾"; signs.changedelete.text = "~";
          on_attach.__raw = ''
            function(bufnr)
              local gitsigns = require('gitsigns')
              local function map(mode, l, r, opts) opts = opts or {}; opts.buffer = bufnr; vim.keymap.set(mode, l, r, opts) end
              map('n', ']c', function() if vim.wo.diff then vim.cmd.normal({']c', bang = true}) else gitsigns.nav_hunk('next') end end, { desc = 'jump to next git [c]hange' })
              map('n', '[c', function() if vim.wo.diff then vim.cmd.normal({'[c', bang = true}) else gitsigns.nav_hunk('prev') end end, { desc = 'jump to previous git [c]hange' })
              map('n', '<leader>hn', function() if vim.wo.diff then vim.cmd.normal({']c', bang = true}) else gitsigns.nav_hunk('next') end end, { desc = 'git [h]unk [n]ext' })
              map('n', '<leader>hN', function() if vim.wo.diff then vim.cmd.normal({'[c', bang = true}) else gitsigns.nav_hunk('prev') end end, { desc = 'git [h]unk previous' })
              map('n', '<leader>hs', gitsigns.stage_hunk, { desc = 'git [s]tage hunk' })
              map('n', '<leader>hr', gitsigns.reset_hunk, { desc = 'git [r]eset hunk' })
              map('v', '<leader>hs', function() gitsigns.stage_hunk {vim.fn.line('.'), vim.fn.line('v')} end, { desc = 'git [s]tage hunk' })
              map('v', '<leader>hr', function() gitsigns.reset_hunk {vim.fn.line('.'), vim.fn.line('v')} end, { desc = 'git [r]eset hunk' })
              map('n', '<leader>hS', gitsigns.stage_buffer, { desc = 'git [S]tage buffer' })
              map('n', '<leader>hu', gitsigns.undo_stage_hunk, { desc = 'git [u]ndo stage hunk' })
              map('n', '<leader>hR', gitsigns.reset_buffer, { desc = 'git [R]eset buffer' })
              map('n', '<leader>hp', gitsigns.preview_hunk, { desc = 'git [p]review hunk' })
              map('n', '<leader>hb', gitsigns.blame_line, { desc = 'git [b]lame line' })
              map('n', '<leader>hd', gitsigns.diffthis, { desc = 'git [d]iff against index' })
              map('n', '<leader>hD', function() gitsigns.diffthis('@') end, { desc = 'git [D]iff against last commit' })
              map('n', '<leader>tb', gitsigns.toggle_current_line_blame, { desc = '[t]oggle git show [b]lame line' })
              map('n', '<leader>tD', gitsigns.toggle_deleted, { desc = '[t]oggle git show [D]eleted' })
            end
          '';
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
        ];
        lsp.keymaps.lspBuf = {
          "<leader>ln" = { mode = "n"; action = "rename"; desc = "lsp: re[n]ame symbol"; };
          "<leader>la" = { mode = [ "n" "x" ]; action = "code_action"; desc = "lsp: code [a]ctions"; };
          "<leader>lD" = { mode = "n"; action = "declaration"; desc = "lsp: goto [D]eclaration"; };
          "<leader>lq" = { mode = "n"; action = "setloclist"; desc = "lsp: diagnostic [q]uickfix list"; };
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
  };
}


