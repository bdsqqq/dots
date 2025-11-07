\- [x] review existing tmux module and related bundles
-\- [x] implement transparent, minimal status bar tweaks
-\- [x] note validation steps and follow-up considerations

suggested validation:
- reload tmux with `prefix + r` and confirm the bar relocates to the top with transparent background.
- open neovim with `vim-tpipeline` enabled to ensure the statusline and tmux bar don't double-render.
