-- Global functions and configuration

-- Floating terminal function
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

-- Highlight tweaks
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

-- Statusline for Zellij
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

-- Zellij Helpers
_G.zellij_update_status = function()
  if vim.env.ZELLIJ then
    local status = _G.Statusline()
    vim.fn.system("zellij pipe 'zjstatus::pipe::pipe_nvim_status::" .. status .. "'")
  end
end

_G.zellij_clear_status = function()
  if vim.env.ZELLIJ then
    vim.fn.system("zellij pipe 'zjstatus::pipe::pipe_nvim_status::'")
  end
end

-- Statusline hidden in nvim
vim.o.laststatus = 0

-- ts-error-translator setup
require("ts-error-translator").setup({
  auto_attach = true,
  servers = { "ts_ls" },
})

-- amp.nvim setup (enables ide integration with amp cli)
require("amp").setup({ auto_start = true, log_level = "info" })

-- amp commands for sending messages to the agent
vim.api.nvim_create_user_command("AmpSend", function(opts)
  local message = opts.args
  if message == "" then
    print("please provide a message to send")
    return
  end
  local amp_message = require("amp.message")
  amp_message.send_message(message)
end, { nargs = "*", desc = "send a message to amp" })

vim.api.nvim_create_user_command("AmpSendBuffer", function()
  local buf = vim.api.nvim_get_current_buf()
  local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  local content = table.concat(lines, "\n")
  local amp_message = require("amp.message")
  amp_message.send_message(content)
end, { desc = "send entire buffer contents to amp" })

vim.api.nvim_create_user_command("AmpAddToPrompt", function(opts)
  local file = vim.fn.expand("%:p")
  local ref = "@" .. file
  if opts.range == 2 then
    ref = ref .. "#L" .. opts.line1 .. "-" .. opts.line2
  elseif opts.line1 > 1 then
    ref = ref .. "#L" .. opts.line1
  end
  local amp_message = require("amp.message")
  amp_message.send_to_prompt(ref)
end, { range = true, desc = "add file reference (with selection) to amp prompt" })

-- Gitsigns on_attach
_G.gitsigns_on_attach = function(bufnr)
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

-- UFO functions
_G.ufo_provider_selector = function(bufnr, filetype, buftype)
  return {'treesitter', 'indent'}
end

_G.ufo_fold_virt_text_handler = function(virtText, lnum, endLnum, width, truncate)
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
