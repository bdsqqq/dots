-- options

vim.g.mapleader = " "
vim.g.maplocalleader = " "
vim.g.have_nerd_font = true
vim.g.tpipeline_autoembed = 0
vim.g.tpipeline_fillchar = " "
vim.g.undotree_FloatDiff = 1
vim.g.undotree_FocusOnToggle = 1

local o = vim.opt
o.number = true
o.mouse = "a"
o.showmode = false
o.laststatus = 0
o.ruler = false
o.cmdheight = 0
o.breakindent = true
o.undofile = true
o.ignorecase = true
o.smartcase = true
o.signcolumn = "yes"
o.updatetime = 250
o.timeoutlen = 300
o.splitright = true
o.splitbelow = true
o.list = true
o.listchars = { tab = "» ", trail = "·", nbsp = "␣" }
o.inccommand = "split"
o.cursorline = false
o.scrolloff = 10
o.confirm = true
o.hlsearch = true
o.clipboard = "unnamedplus"
o.foldcolumn = "0"
o.foldlevel = 99
o.foldlevelstart = 99
o.foldenable = true
o.statuscolumn = "%{foldclosed(v:lnum) > 0 ? '>  ' : ''}%{foldclosed(v:lnum) == -1 ? v:lnum . ' ' : ''}"
o.winblend = 0
o.pumblend = 0

-- floating terminal

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
      if vim.api.nvim_win_is_valid(win) then vim.api.nvim_win_close(win, true) end
      if vim.api.nvim_buf_is_valid(buf) then vim.api.nvim_buf_delete(buf, { force = true }) end
    end,
  })
  vim.cmd("startinsert")
end

_G.open_floating_term = open_floating_term
_G.MyFoldText = function() return vim.fn.foldtext() end

-- keymaps

vim.keymap.set("n", "<Esc>", "<cmd>nohlsearch<CR>")
vim.keymap.set("t", "<Esc><Esc>", "<C-\\><C-n>", { desc = "exit terminal mode" })
vim.keymap.set("n", "<C-h>", "<cmd>TmuxNavigateLeft<CR>", { desc = "move pane focus left" })
vim.keymap.set("n", "<C-l>", "<cmd>TmuxNavigateRight<CR>", { desc = "move pane focus right" })
vim.keymap.set("n", "<C-j>", "<cmd>TmuxNavigateDown<CR>", { desc = "move pane focus down" })
vim.keymap.set("n", "<C-k>", "<cmd>TmuxNavigateUp<CR>", { desc = "move pane focus up" })
vim.keymap.set("n", "<C-\\>", "<cmd>TmuxNavigatePrevious<CR>", { desc = "move pane focus previous" })
vim.keymap.set("n", "<C-_>", "gcc", { desc = "toggle comment", remap = true })
vim.keymap.set("v", "<C-_>", "gcgv", { desc = "toggle comment", remap = true })

vim.keymap.set("", "<leader>f", function()
  require("conform").format({ async = true, lsp_fallback = true })
end, { desc = "[f]ormat buffer" })

vim.keymap.set("n", "<leader>/", function()
  require("telescope.builtin").current_buffer_fuzzy_find(require("telescope.themes").get_dropdown({ winblend = 10, previewer = false }))
end, { desc = "[/] fuzzily search in current buffer" })

vim.keymap.set("n", "<leader>s/", function()
  require("telescope.builtin").live_grep({ grep_open_files = true, prompt_title = "Live Grep in Open Files" })
end, { desc = "[s]earch [/] in open files" })

vim.keymap.set("n", "<leader>sn", function()
  require("telescope.builtin").find_files({ cwd = vim.fn.stdpath("config") })
end, { desc = "[s]earch [n]eovim files" })

vim.keymap.set("n", "<leader>tf", function()
  local ok, mini_files = pcall(require, "mini.files")
  if ok then mini_files.open() else vim.cmd("Explore") end
end, { desc = "[t]oggle [f]iles" })

vim.keymap.set("n", "<leader>tu", "<cmd>UndotreeToggle<CR>", { desc = "[t]oggle [u]ndo tree" })

vim.keymap.set("n", "<leader>to", function()
  require("oil").open()
end, { desc = "[t]oggle [o]il" })

vim.keymap.set("n", "<leader>sb", function()
  require("telescope.builtin").buffers()
end, { desc = "[s]earch [b]uffers" })

vim.keymap.set("n", "<leader>tw", "<cmd>set wrap!<CR>", { desc = "[t]oggle [w]ord wrap" })

vim.keymap.set("n", "<leader>tl", function()
  local enabled = vim.diagnostic.is_enabled()
  vim.diagnostic.enable(not enabled)
  vim.notify("Diagnostics " .. (enabled and "disabled" or "enabled"))
end, { desc = "[t]oggle [l]sp diagnostics" })

vim.keymap.set("n", "<leader>tn", "<cmd>set nu!<CR>", { desc = "[t]oggle line [n]umbers" })
vim.keymap.set("n", "<leader>tr", "<cmd>set rnu!<CR>", { desc = "[t]oggle [r]elative numbers" })

vim.keymap.set("n", "<leader>tg", function()
  _G.open_floating_term("lazygit")
end, { desc = "[t]oggle [g]it (lazygit)" })

local function fold_or_left()
  if vim.fn.col(".") == 1 then pcall(vim.cmd, "normal! za") else vim.cmd("normal! h") end
end
vim.keymap.set("n", "<Left>", fold_or_left, { desc = "toggle fold at first column, otherwise move left" })
vim.keymap.set("n", "h", fold_or_left, { desc = "toggle fold at first column, otherwise move left" })

-- autocommands

vim.api.nvim_create_augroup("kickstart-highlight-yank", { clear = true })
vim.api.nvim_create_autocmd("TextYankPost", {
  desc = "highlight when yanking (copying) text",
  group = "kickstart-highlight-yank",
  callback = function() vim.highlight.on_yank() end,
})

vim.api.nvim_create_autocmd("ColorScheme", {
  callback = function()
    local comment_hl = vim.api.nvim_get_hl(0, { name = "Comment" })
    vim.api.nvim_set_hl(0, "FoldColumn", { fg = comment_hl.fg })
  end,
})

-- diagnostics

vim.diagnostic.config({
  severity_sort = true,
  float = { border = "rounded", source = "if_many" },
  underline = { severity = { vim.diagnostic.severity.ERROR } },
  signs = {
    text = {
      [vim.diagnostic.severity.ERROR] = "✘",
      [vim.diagnostic.severity.WARN] = "⚠",
      [vim.diagnostic.severity.INFO] = "ℹ",
      [vim.diagnostic.severity.HINT] = "⚑",
    },
  },
  virtual_text = { source = "if_many", spacing = 2 },
})

-- highlights

vim.defer_fn(function()
  local comment_hl = vim.api.nvim_get_hl(0, { name = "Comment" })
  vim.api.nvim_set_hl(0, "FoldColumn", { fg = comment_hl.fg })
  vim.api.nvim_set_hl(0, "Normal", { bg = "NONE", ctermbg = "NONE" })
  vim.api.nvim_set_hl(0, "NormalFloat", { bg = "NONE", ctermbg = "NONE" })
  vim.api.nvim_set_hl(0, "SignColumn", { bg = "NONE", ctermbg = "NONE" })
  vim.api.nvim_set_hl(0, "LineNr", { bg = "NONE", ctermbg = "NONE" })
  vim.api.nvim_set_hl(0, "NonText", { bg = "NONE", ctermbg = "NONE" })
  vim.api.nvim_set_hl(0, "EndOfBuffer", { bg = "NONE", ctermbg = "NONE" })
  vim.api.nvim_set_hl(0, "Terminal", { bg = "NONE", ctermbg = "NONE" })
end, 100)

-- plugins

require("oil").setup({
  default_file_explorer = true,
  delete_to_trash = true,
  skip_confirm_for_simple_edits = true,
  view_options = { show_hidden = true },
})

local function ufo_fold_virt_text_handler(virtText, lnum, endLnum, width, truncate)
  local newVirtText = {}
  local curWidth = 0
  for _, chunk in ipairs(virtText) do
    local chunkText = chunk[1]
    local chunkWidth = vim.fn.strdisplaywidth(chunkText)
    if width > curWidth + chunkWidth then
      table.insert(newVirtText, chunk)
    else
      chunkText = truncate(chunkText, width - curWidth)
      table.insert(newVirtText, { chunkText, chunk[2] })
      break
    end
    curWidth = curWidth + chunkWidth
  end
  return newVirtText
end

require("ufo").setup({
  provider_selector = function() return { "treesitter", "indent" } end,
  fold_virt_text_handler = ufo_fold_virt_text_handler,
})

require("fidget").setup({})
require("autoclose").setup({})

require("lazydev").setup({
  library = { { path = "${3rd}/luv/library", words = { "vim%.uv" } } },
})

require("gitsigns").setup({
  signs = {
    add = { text = "+" },
    change = { text = "~" },
    delete = { text = "_" },
    topdelete = { text = "‾" },
    changedelete = { text = "~" },
  },
  on_attach = function(bufnr)
    local gitsigns = require("gitsigns")
    local function map(mode, l, r, opts)
      opts = opts or {}
      opts.buffer = bufnr
      vim.keymap.set(mode, l, r, opts)
    end
    map("n", "]c", function()
      if vim.wo.diff then vim.cmd.normal({ "]c", bang = true }) else gitsigns.nav_hunk("next") end
    end, { desc = "jump to next git [c]hange" })
    map("n", "[c", function()
      if vim.wo.diff then vim.cmd.normal({ "[c", bang = true }) else gitsigns.nav_hunk("prev") end
    end, { desc = "jump to previous git [c]hange" })
    map("n", "<leader>hn", function()
      if vim.wo.diff then vim.cmd.normal({ "]c", bang = true }) else gitsigns.nav_hunk("next") end
    end, { desc = "git [h]unk [n]ext" })
    map("n", "<leader>hN", function()
      if vim.wo.diff then vim.cmd.normal({ "[c", bang = true }) else gitsigns.nav_hunk("prev") end
    end, { desc = "git [h]unk previous" })
    map("n", "<leader>hs", gitsigns.stage_hunk, { desc = "git [s]tage hunk" })
    map("n", "<leader>hr", gitsigns.reset_hunk, { desc = "git [r]eset hunk" })
    map("v", "<leader>hs", function() gitsigns.stage_hunk({ vim.fn.line("."), vim.fn.line("v") }) end, { desc = "git [s]tage hunk" })
    map("v", "<leader>hr", function() gitsigns.reset_hunk({ vim.fn.line("."), vim.fn.line("v") }) end, { desc = "git [r]eset hunk" })
    map("n", "<leader>hS", gitsigns.stage_buffer, { desc = "git [S]tage buffer" })
    map("n", "<leader>hu", gitsigns.undo_stage_hunk, { desc = "git [u]ndo stage hunk" })
    map("n", "<leader>hR", gitsigns.reset_buffer, { desc = "git [R]eset buffer" })
    map("n", "<leader>hp", gitsigns.preview_hunk, { desc = "git [p]review hunk" })
    map("n", "<leader>hb", gitsigns.blame_line, { desc = "git [b]lame line" })
    map("n", "<leader>hd", gitsigns.diffthis, { desc = "git [d]iff against index" })
    map("n", "<leader>hD", function() gitsigns.diffthis("@") end, { desc = "git [D]iff against last commit" })
    map("n", "<leader>tb", gitsigns.toggle_current_line_blame, { desc = "[t]oggle git show [b]lame line" })
    map("n", "<leader>tD", gitsigns.toggle_deleted, { desc = "[t]oggle git show [D]eleted" })
  end,
})

require("which-key").setup({})
require("which-key").add({
  { "<leader>s", group = "[s]earch" },
  { "<leader>t", group = "[t]oggle" },
  { "<leader>h", group = "git [h]unk", mode = { "n", "v" } },
  { "<leader>l", group = "[l]sp" },
})

require("telescope").setup({
  defaults = { file_ignore_patterns = {}, hidden = true },
  pickers = { find_files = { hidden = true } },
  extensions = { ["ui-select"] = { require("telescope.themes").get_dropdown() } },
})
require("telescope").load_extension("fzf")
require("telescope").load_extension("ui-select")

local builtin = require("telescope.builtin")
vim.keymap.set("n", "<leader>sh", builtin.help_tags, { desc = "[s]earch [h]elp" })
vim.keymap.set("n", "<leader>sk", builtin.keymaps, { desc = "[s]earch [k]eymaps" })
vim.keymap.set("n", "<leader>sf", builtin.find_files, { desc = "[s]earch [f]iles" })
vim.keymap.set("n", "<leader>ss", builtin.builtin, { desc = "[s]earch [s]elect telescope" })
vim.keymap.set("n", "<leader>sw", builtin.grep_string, { desc = "[s]earch current [w]ord" })
vim.keymap.set("n", "<leader>sg", builtin.live_grep, { desc = "[s]earch by [g]rep" })
vim.keymap.set("n", "<leader>sd", builtin.diagnostics, { desc = "[s]earch [d]iagnostics" })
vim.keymap.set("n", "<leader>sr", builtin.resume, { desc = "[s]earch [r]esume" })
vim.keymap.set("n", "<leader>s.", builtin.oldfiles, { desc = "[s]earch recent files ('.' for repeat)" })
vim.keymap.set("n", "<leader><leader>", builtin.buffers, { desc = "[ ] find existing buffers" })

require("ts-error-translator").setup({ auto_attach = true, servers = { "ts_ls" } })

require("amp").setup({ auto_start = true, log_level = "info" })

vim.api.nvim_create_user_command("AmpSend", function(opts)
  local message = opts.args
  if message == "" then
    print("please provide a message to send")
    return
  end
  require("amp.message").send_message(message)
end, { nargs = "*", desc = "send a message to amp" })

vim.api.nvim_create_user_command("AmpSendBuffer", function()
  local buf = vim.api.nvim_get_current_buf()
  local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  require("amp.message").send_message(table.concat(lines, "\n"))
end, { desc = "send entire buffer contents to amp" })

vim.api.nvim_create_user_command("AmpAddToPrompt", function(opts)
  local file = vim.fn.expand("%:p")
  local ref = "@" .. file
  if opts.range == 2 then
    ref = ref .. "#L" .. opts.line1 .. "-" .. opts.line2
  elseif opts.line1 > 1 then
    ref = ref .. "#L" .. opts.line1
  end
  require("amp.message").send_to_prompt(ref)
end, { range = true, desc = "add file reference (with selection) to amp prompt" })

require("mini.icons").setup({})
require("mini.icons").mock_nvim_web_devicons()
require("mini.surround").setup({})
require("mini.comment").setup({})
require("mini.files").setup({
  options = { permanent_delete = true, use_as_default_explorer = true },
  content = { filter = function() return true end },
})

vim.api.nvim_create_autocmd("FileType", {
  callback = function(args)
    pcall(vim.treesitter.start, args.buf)
  end,
})

require("conform").setup({
  notify_on_error = false,
  format_on_save = function(bufnr)
    local disable_filetypes = { c = true, cpp = true }
    return {
      timeout_ms = 500,
      lsp_fallback = not disable_filetypes[vim.bo[bufnr].filetype],
      quiet = true,
    }
  end,
  formatters = {
    biome = { condition = function() return vim.fn.executable("biome") == 1 end },
    gofmt = { condition = function() return vim.fn.executable("gofmt") == 1 end },
  },
  formatters_by_ft = {
    lua = { "stylua" },
    javascript = { "biome" },
    typescript = { "biome" },
    javascriptreact = { "biome" },
    typescriptreact = { "biome" },
    json = { "biome" },
    go = { "gofmt" },
  },
})

require("blink.cmp").setup({
  keymap = {
    preset = "default",
    ["<Tab>"] = { "snippet_forward", "fallback" },
    ["<S-Tab>"] = { "snippet_backward", "fallback" },
    ["<CR>"] = { "accept", "fallback" },
    ["<Down>"] = { "select_next", "fallback" },
    ["<Up>"] = { "select_prev", "fallback" },
    ["<Esc>"] = { "hide", "fallback" },
  },
  appearance = { nerd_font_variant = "mono" },
  completion = {
    documentation = { auto_show = true, auto_show_delay_ms = 500 },
    ghost_text = { enabled = true },
    menu = { auto_show = true, draw = { treesitter = { "lsp" } } },
  },
  sources = {
    default = { "lsp", "path", "snippets", "buffer" },
    providers = {
      lazydev = { name = "LazyDev", module = "lazydev.integrations.blink", score_offset = 100 },
    },
  },
  snippets = { preset = "default" },
  signature = { enabled = true },
})

-- lsp

vim.api.nvim_create_augroup("kickstart-lsp-attach", { clear = true })
vim.api.nvim_create_autocmd("LspAttach", {
  group = "kickstart-lsp-attach",
  callback = function(ev)
    local function map(mode, key, fn, desc)
      vim.keymap.set(mode, key, fn, { buffer = ev.buf, desc = desc })
    end
    local function tele(method)
      local ok, t = pcall(require, "telescope.builtin")
      if ok then return t[method] end
      return nil
    end

    map("n", "gd", tele("lsp_definitions") or vim.lsp.buf.definition, "lsp: [g]oto [d]efinition")
    map("n", "gr", tele("lsp_references") or vim.lsp.buf.references, "lsp: [g]oto [r]eferences")
    map("n", "gi", tele("lsp_implementations") or vim.lsp.buf.implementation, "lsp: [g]oto [i]mplementation")
    map("n", "gt", tele("lsp_type_definitions") or vim.lsp.buf.type_definition, "lsp: [g]oto [t]ype definition")
    map("n", "gO", tele("lsp_document_symbols") or vim.lsp.buf.document_symbol, "lsp: open document symbols")
    map("n", "gW", tele("lsp_dynamic_workspace_symbols") or vim.lsp.buf.workspace_symbol, "lsp: open workspace symbols")
    map("n", "<leader>ld", tele("lsp_definitions") or vim.lsp.buf.definition, "lsp: goto [d]efinition")
    map("n", "<leader>lr", tele("lsp_references") or vim.lsp.buf.references, "lsp: goto [r]eferences (find usages)")
    map("n", "<leader>li", tele("lsp_implementations") or vim.lsp.buf.implementation, "lsp: goto [i]mplementation")
    map("n", "<leader>lt", tele("lsp_type_definitions") or vim.lsp.buf.type_definition, "lsp: goto [t]ype definition")
    map("n", "<leader>ls", tele("lsp_dynamic_workspace_symbols") or vim.lsp.buf.workspace_symbol, "lsp: workspace [s]ymbols")
    map("n", "<leader>lq", vim.diagnostic.setloclist, "lsp: diagnostic [q]uickfix list")
    map("n", "<leader>ln", vim.lsp.buf.rename, "lsp: re[n]ame symbol")
    map({ "n", "x" }, "<leader>la", vim.lsp.buf.code_action, "lsp: code [a]ctions")
    map("n", "<leader>lD", vim.lsp.buf.declaration, "lsp: goto [D]eclaration")
    map("n", "<leader>lh", vim.lsp.buf.hover, "lsp: [h]over documentation")
    map("n", "K", vim.lsp.buf.hover, "hover documentation")
  end,
})

vim.lsp.config("*", {
  capabilities = require("blink.cmp").get_lsp_capabilities(),
})

vim.lsp.config("lua_ls", {
  settings = { Lua = { completion = { callSnippet = "Replace" } } },
})

vim.lsp.enable({ "lua_ls", "ts_ls", "gopls" })
