{ pkgs, inputs, lib, ... }: {
  programs.nixvim = {
    enable = true;

    extraPlugins = [
      (pkgs.vimUtils.buildVimPlugin {
        name = "vesper.nvim";
        src = pkgs.fetchFromGitHub {
          owner = "datsfilipe";
          repo = "vesper.nvim";
          rev = "a9b6893e4aa2f37b85ac17a2e58a0b37d1bb3db3";
          sha256 = "sha256-Tx621yTfTu3dLctXKPaJy6rZn2YvWP8eFAJoVvEeR/c=";
        };
        doCheck = false;
      })
    ];

    extraConfigLuaPre = ''
      -- vesper colorscheme setup
      require('vesper').setup {
        transparent = true,
        styles = {
          comments = { italic = false },
        },
      }
      vim.cmd.colorscheme('vesper')
    '';

    globals = {
      mapleader = " ";
      maplocalleader = " ";
      have_nerd_font = false;
    };

    clipboard = {
      providers = {
        wl-copy.enable = true;
        xsel.enable = true;
      };
      register = "unnamedplus";
    };

    opts = {
      number = true;
      mouse = "a";
      showmode = false;
      breakindent = true;
      undofile = true;
      ignorecase = true;
      smartcase = true;
      signcolumn = "yes";
      updatetime = 250;
      timeoutlen = 300;
      splitright = true;
      splitbelow = true;
      list = true;
      listchars.__raw = "{ tab = '» ', trail = '·', nbsp = '␣' }";
      inccommand = "split";
      cursorline = false;
      scrolloff = 10;
      confirm = true;
      hlsearch = true;
      relativenumber = true;
    };

    # global keymaps (truly global + plugins without keymap support)
    keymaps = [
      # clear search highlights
      {
        mode = "n";
        key = "<Esc>";
        action = "<cmd>nohlsearch<CR>";
      }
      # exit terminal mode
      {
        mode = "t";
        key = "<Esc><Esc>";
        action = "<C-\\><C-n>";
        options.desc = "exit terminal mode";
      }
      # split navigation
      {
        mode = "n";
        key = "<C-h>";
        action = "<C-w><C-h>";
        options.desc = "move focus to left window";
      }
      {
        mode = "n";
        key = "<C-l>";
        action = "<C-w><C-l>";
        options.desc = "move focus to right window";
      }
      {
        mode = "n";
        key = "<C-j>";
        action = "<C-w><C-j>";
        options.desc = "move focus to lower window";
      }
      {
        mode = "n";
        key = "<C-k>";
        action = "<C-w><C-k>";
        options.desc = "move focus to upper window";
      }
      # conform formatting keymap (no built-in keymap support)
      {
        mode = "";
        key = "<leader>f";
        action.__raw = ''
          function()
            require('conform').format { async = true, lsp_fallback = true }
          end
        '';
        options.desc = "[f]ormat buffer";
      }
      # mini.map toggle (no built-in keymap support)
      {
        mode = "n";
        key = "<leader>tm";
        action.__raw = ''
          function()
            require('mini.map').toggle()
          end
        '';
        options.desc = "[t]oggle [m]inimap";
      }
      # custom telescope keymaps (require __raw)
      {
        mode = "n";
        key = "<leader>/";
        action.__raw = ''
          function()
            require('telescope.builtin').current_buffer_fuzzy_find(
              require('telescope.themes').get_dropdown {
                winblend = 10,
                previewer = false
              }
            )
          end
        '';
        options.desc = "[/] fuzzily search in current buffer";
      }
      {
        mode = "n";
        key = "<leader>s/";
        action.__raw = ''
          function()
            require('telescope.builtin').live_grep {
              grep_open_files = true,
              prompt_title = 'Live Grep in Open Files'
            }
          end
        '';
        options.desc = "[s]earch [/] in open files";
      }
      {
        mode = "n";
        key = "<leader>sn";
        action.__raw = ''
          function()
            require('telescope.builtin').find_files {
              cwd = vim.fn.stdpath 'config'
            }
          end
        '';
        options.desc = "[s]earch [n]eovim files";
      }
      # mini.files and undotree toggles
      {
        mode = "n";
        key = "<leader>tf";
        action.__raw = ''
          function()
            local ok, mini_files = pcall(require, 'mini.files')
            if ok then
              mini_files.open()
            else
              vim.cmd('Explore')
            end
          end
        '';
        options.desc = "[t]oggle [f]iles";
      }
      {
        mode = "n";
        key = "<leader>tu";
        action = "<cmd>UndotreeToggle<CR>";
        options.desc = "[t]oggle [u]ndo tree";
      }
      # additional consistency keybindings
      {
        mode = "n";
        key = "<leader>ta";
        action.__raw = ''
          function()
            local ok, avante_api = pcall(require, 'avante.api')
            if ok and avante_api.toggle then
              avante_api.toggle.sidebar()
            else
              vim.notify('Avante not available', vim.log.levels.WARN)
            end
          end
        '';
        options.desc = "[t]oggle [a]vante";
      }
      {
        mode = "n";
        key = "<leader>sb";
        action.__raw = ''
          function()
            require('telescope.builtin').buffers()
          end
        '';
        options.desc = "[s]earch [b]uffers";
      }
      {
        mode = "n";
        key = "<leader>tw";
        action = "<cmd>set wrap!<CR>";
        options.desc = "[t]oggle [w]ord wrap";
      }
      {
        mode = "n";
        key = "<leader>tl";
        action.__raw = ''
          function()
            local enabled = vim.diagnostic.is_enabled()
            vim.diagnostic.enable(not enabled)
            vim.notify("Diagnostics " .. (enabled and "disabled" or "enabled"))
          end
        '';
        options.desc = "[t]oggle [l]sp diagnostics";
      }
      {
        mode = "n";
        key = "<leader>tn";
        action = "<cmd>set nu!<CR>";
        options.desc = "[t]oggle line [n]umbers";
      }
      {
        mode = "n";
        key = "<leader>tr";
        action = "<cmd>set rnu!<CR>";
        options.desc = "[t]oggle [r]elative numbers";
      }
    ];

    autoGroups = {
      kickstart-highlight-yank.clear = true;
      kickstart-lsp-attach.clear = true;
    };

    autoCmd = [
      {
        event = [ "TextYankPost" ];
        desc = "highlight when yanking (copying) text";
        group = "kickstart-highlight-yank";
        callback.__raw = ''
          function()
            vim.highlight.on_yank()
          end
        '';
      }
    ];

    diagnostic = {
      settings = {
        severity_sort = true;
        float = {
          border = "rounded";
          source = "if_many";
        };
        underline.severity = [ "ERROR" ];
        signs.text = {
          ERROR = "✘";
          WARN = "⚠";
          INFO = "ℹ";
          HINT = "⚑";
        };
        virtual_text = {
          source = "if_many";
          spacing = 2;
        };
      };
    };

    extraPackages = with pkgs; [
      stylua
      nodePackages.prettier
      go
    ];

    plugins = {
      web-devicons.enable = true;
      sleuth.enable = true;
      fidget.enable = true;
      lazydev = {
        enable = true;
        settings = {
          library = [
            {
              path = "\${3rd}/luv/library";
              words = [ "vim%.uv" ];
            }
          ];
        };
      };

      gitsigns = {
        enable = true;
        settings = {
          signs = {
            add.text = "+";
            change.text = "~";
            delete.text = "_";
            topdelete.text = "‾";
            changedelete.text = "~";
          };
          on_attach.__raw = ''
            function(bufnr)
              local gitsigns = require('gitsigns')
              
              local function map(mode, l, r, opts)
                opts = opts or {}
                opts.buffer = bufnr
                vim.keymap.set(mode, l, r, opts)
              end
              
              -- navigation
              map('n', ']c', function()
                if vim.wo.diff then
                  vim.cmd.normal({']c', bang = true})
                else
                  gitsigns.nav_hunk('next')
                end
              end, { desc = 'jump to next git [c]hange' })
              
              map('n', '[c', function()
                if vim.wo.diff then
                  vim.cmd.normal({'[c', bang = true})
                else
                  gitsigns.nav_hunk('prev')
                end
              end, { desc = 'jump to previous git [c]hange' })
              
              -- actions
              map('n', '<leader>hn', function()
                if vim.wo.diff then
                  vim.cmd.normal({']c', bang = true})
                else
                  gitsigns.nav_hunk('next')
                end
              end, { desc = 'git [h]unk [n]ext' })
              
              map('n', '<leader>hN', function()
                if vim.wo.diff then
                  vim.cmd.normal({'[c', bang = true})
                else
                  gitsigns.nav_hunk('prev')
                end
              end, { desc = 'git [h]unk previous' })
              
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
      };

      which-key = {
        enable = true;
        settings = {
          spec = [
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
        };
      };

      telescope = {
        enable = true;
        extensions = {
          fzf-native.enable = true;
          ui-select.enable = true;
        };
        keymaps = {
          "<leader>sh" = {
            mode = "n";
            action = "help_tags";
            options.desc = "[s]earch [h]elp";
          };
          "<leader>sk" = {
            mode = "n";
            action = "keymaps";
            options.desc = "[s]earch [k]eymaps";
          };
          "<leader>sf" = {
            mode = "n";
            action = "find_files";
            options.desc = "[s]earch [f]iles";
          };
          "<leader>ss" = {
            mode = "n";
            action = "builtin";
            options.desc = "[s]earch [s]elect telescope";
          };
          "<leader>sw" = {
            mode = "n";
            action = "grep_string";
            options.desc = "[s]earch current [w]ord";
          };
          "<leader>sg" = {
            mode = "n";
            action = "live_grep";
            options.desc = "[s]earch by [g]rep";
          };
          "<leader>sd" = {
            mode = "n";
            action = "diagnostics";
            options.desc = "[s]earch [d]iagnostics";
          };
          "<leader>sr" = {
            mode = "n";
            action = "resume";
            options.desc = "[s]earch [r]esume";
          };
          "<leader>s." = {
            mode = "n";
            action = "oldfiles";
            options.desc = "[s]earch recent files ('.' for repeat)";
          };
          "<leader><leader>" = {
            mode = "n";
            action = "buffers";
            options.desc = "[ ] find existing buffers";
          };
        };
        settings = {
          extensions.__raw = "{ ['ui-select'] = { require('telescope.themes').get_dropdown() } }";
        };
      };

      lsp = {
        enable = true;
        servers = {
          lua_ls = {
            enable = true;
            settings = {
              completion.callSnippet = "Replace";
            };
          };
          ts_ls.enable = true;
          gopls.enable = true;
        };
        keymaps = {
          diagnostic = { };
          # deliberately override vim's built-in goto commands with lsp versions
          # this is intentional - we want lsp-powered navigation, not vim's text search
          # fallback to vim.lsp.buf if telescope fails to load
          extra = [
            {
              mode = "n";
              key = "gd";
              action.__raw = ''
                function()
                  local ok, telescope = pcall(require, 'telescope.builtin')
                  if ok then
                    telescope.lsp_definitions()
                  else
                    vim.lsp.buf.definition()
                  end
                end
              '';
              options.desc = "lsp: [g]oto [d]efinition";
            }
            {
              mode = "n";
              key = "gr";
              action.__raw = ''
                function()
                  local ok, telescope = pcall(require, 'telescope.builtin')
                  if ok then
                    telescope.lsp_references()
                  else
                    vim.lsp.buf.references()
                  end
                end
              '';
              options.desc = "lsp: [g]oto [r]eferences";
            }
            {
              mode = "n";
              key = "gi";
              action.__raw = ''
                function()
                  local ok, telescope = pcall(require, 'telescope.builtin')
                  if ok then
                    telescope.lsp_implementations()
                  else
                    vim.lsp.buf.implementation()
                  end
                end
              '';
              options.desc = "lsp: [g]oto [i]mplementation";
            }
            {
              mode = "n";
              key = "gt";
              action.__raw = ''
                function()
                  local ok, telescope = pcall(require, 'telescope.builtin')
                  if ok then
                    telescope.lsp_type_definitions()
                  else
                    vim.lsp.buf.type_definition()
                  end
                end
              '';
              options.desc = "lsp: [g]oto [t]ype definition";
            }
            {
              mode = "n";
              key = "gO";
              action.__raw = "require('telescope.builtin').lsp_document_symbols";
              options.desc = "lsp: open document symbols";
            }
            {
              mode = "n";
              key = "gW";
              action.__raw = "require('telescope.builtin').lsp_dynamic_workspace_symbols";
              options.desc = "lsp: open workspace symbols";
            }
            # lsp namespace - duplicates of g shortcuts for discoverability
            {
              mode = "n";
              key = "<leader>ld";
              action.__raw = "require('telescope.builtin').lsp_definitions";
              options.desc = "lsp: goto [d]efinition";
            }
            {
              mode = "n";
              key = "<leader>lr";
              action.__raw = "require('telescope.builtin').lsp_references";
              options.desc = "lsp: goto [r]eferences (find usages)";
            }
            {
              mode = "n";
              key = "<leader>li";
              action.__raw = "require('telescope.builtin').lsp_implementations";
              options.desc = "lsp: goto [i]mplementation";
            }
            {
              mode = "n";
              key = "<leader>lt";
              action.__raw = "require('telescope.builtin').lsp_type_definitions";
              options.desc = "lsp: goto [t]ype definition";
            }
            {
              mode = "n";
              key = "<leader>ls";
              action.__raw = "require('telescope.builtin').lsp_dynamic_workspace_symbols";
              options.desc = "lsp: workspace [s]ymbols";
            }
          ];
          lspBuf = {
            "<leader>ln" = {
              action = "rename";
              desc = "lsp: re[n]ame symbol";
            };
            "<leader>la" = {
              mode = [ "n" "x" ];
              action = "code_action";
              desc = "lsp: code [a]ctions";
            };
            "<leader>lD" = {
              action = "declaration";
              desc = "lsp: goto [D]eclaration";
            };
            "<leader>lq" = {
              action = "setloclist";
              desc = "lsp: diagnostic [q]uickfix list";
            };
            "<leader>lh" = {
              action = "hover";
              desc = "lsp: [h]over documentation";
            };
            "K" = {
              action = "hover";
              desc = "hover documentation";
            };
          };
        };
      };

      conform-nvim = {
        enable = true;
        settings = {
          notify_on_error = false;
          format_on_save = ''
            function(bufnr)
              local disable_filetypes = { c = true, cpp = true }
              return {
                timeout_ms = 500,
                lsp_fallback = not disable_filetypes[vim.bo[bufnr].filetype],
                -- gracefully handle missing formatters
                quiet = true
              }
            end
          '';
          # custom formatter conditions to check availability
          formatters = {
            prettier = {
              condition = ''
                function()
                  return vim.fn.executable("prettier") == 1
                end
              '';
            };
            gofmt = {
              condition = ''
                function()
                  return vim.fn.executable("gofmt") == 1
                end
              '';
            };
          };
          formatters_by_ft = {
            lua = [ "stylua" ];
            javascript = [ "prettier" ];
            typescript = [ "prettier" ];
            javascriptreact = [ "prettier" ];
            typescriptreact = [ "prettier" ];
            json = [ "prettier" ];
            go = [ "gofmt" ];
          };
        };
      };

      blink-cmp = {
        enable = true;
        settings = {
          keymap = {
            preset = "default";
            "<Tab>" = [ "snippet_forward" "fallback" ];
            "<S-Tab>" = [ "snippet_backward" "fallback" ];
          };
          appearance.nerd_font_variant = "mono";
          completion = {
            documentation = {
              auto_show = true;
              auto_show_delay_ms = 500;
            };
            ghost_text.enabled = true;
            menu = {
              auto_show = true;
              draw.treesitter = [ "lsp" ];
              max_items = 200;
            };
          };
          sources = {
            default = [ "lsp" "path" "snippets" "buffer" ];
            providers = {
              lazydev = {
                name = "LazyDev";
                module = "lazydev.integrations.blink";
                score_offset = 100;
              };
            };
          };
          snippets.preset = "default";
          fuzzy.use_fzf = true;
          signature.enabled = true;
        };
      };

      mini = {
        enable = true;
        modules = {
          ai.n_lines = 500;
          surround = { };
          statusline.use_icons.__raw = "vim.g.have_nerd_font";
          comment = { };
          files = { };
          map = {
            symbols = {
              scroll_line = "█";
              scroll_view = "┃";
            };
            window = {
              focusable = false;
              side = "right";
              width = 10;
              winblend = 25;
              show_integration_count = true;
            };
          };
        };
      };

      undotree = {
        enable = true;
        settings = {
          FocusOnToggle = true;
          WindowLayout = 2;
        };
      };

      treesitter = {
        enable = true;
        settings = {
          ensureInstalled = [
            "bash"
            "c"
            "diff"
            "html"
            "lua"
            "luadoc"
            "markdown"
            "markdown_inline"
            "query"
            "vim"
            "vimdoc"
            "nix"
            "javascript"
            "typescript"
            "jsx"
            "tsx"
            "json"
            "jsonc"
            "python"
            "regex"
            "go"
          ];
          highlight = {
            enable = true;
            additional_vim_regex_highlighting = true;
          };
          indent = {
            enable = true;
            disable = [ "ruby" ];
          };
        };
      };

      avante = {
        enable = true;
        settings = {
          provider = "claude";
          providers = {
            claude = {
              endpoint = "https://api.anthropic.com";
              model = "claude-3-5-sonnet-20241022";
              extra_request_body = {
                temperature = 0;
                max_tokens = 4096;
              };
            };
            openai = {
              endpoint = "https://api.openai.com/v1";
              model = "gpt-4o";
              extra_request_body = {
                temperature = 0;
                max_tokens = 4096;
              };
            };
          };
          behaviour = {
            auto_suggestions = false;
            auto_set_highlight_group = true;
            auto_set_keymaps = true;
            auto_apply_diff_after_generation = false;
            support_paste_from_clipboard = false;
          };
          mappings = {
            ask = "<leader>aa";
            edit = "<leader>ae";
            refresh = "<leader>ar";
            diff = {
              ours = "co";
              theirs = "ct";
              all_theirs = "ca";
              both = "cb";
              cursor = "cc";
              next = "]x";
              prev = "[x";
            };
            suggestion = {
              accept = "<M-l>";
              next = "<M-]>";
              prev = "<M-[>";
              dismiss = "<C-]>";
            };
            jump = {
              next = "]]";
              prev = "[[";
            };
            submit = {
              normal = "<CR>";
              insert = "<C-s>";
            };
            sidebar = {
              apply_all = "A";
              apply_cursor = "a";
              switch_windows = "<Tab>";
              reverse_switch_windows = "<S-Tab>";
            };
          };
          hints.enabled = true;
          windows = {
            position = "right";
            wrap = true;
            width = 30;
            sidebar_header = {
              align = "center";
              rounded = true;
            };
          };
          file_selector.provider = "telescope";
          dual_boost = {
            enabled = false;
            first_provider = "openai";
            second_provider = "claude";
            prompt = "based on the two reference outputs below, write a response that incorporates the best aspects of both:";
            timeout = 60000;
          };
        };
      };
    };

    extraConfigLua = ''
      -- mini.statusline cursor location format
      require('mini.statusline').section_location = function()
        return '%2l:%-2v'
      end
    '';
  };
}
