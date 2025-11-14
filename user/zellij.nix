{ lib, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
  
  copyCommand = if isDarwin then "pbcopy" else "wl-copy";
  
  zellijLayoutConfig = ''
    layout {
      default_tab_template {
        pane size=1 borderless=true {
          plugin location="https://github.com/dj95/zjstatus/releases/download/v0.21.0/zjstatus.wasm" {
            format_left   ""
            format_right  "{tabs}"
            format_space  ""
            format_precedence "lrc"
            
            border_enabled  "false"
            border_char     "─"
            border_format   "#[fg=#6C7086]{char}"
            border_position "top"

            hide_frame_for_single_pane "false"

            mode_normal        ""
            mode_locked        ""
            mode_resize        ""
            mode_pane          ""
            mode_tab           ""
            mode_scroll        ""
            mode_enter_search  ""
            mode_search        ""
            mode_rename_tab    ""
            mode_rename_pane   ""
            mode_session       ""
            mode_move          ""
            mode_prompt        ""
            mode_tmux          ""

            tab_normal              "#[fg=#6b7280][{name}]#[default] "
            tab_active              "#[fg=#d1d5db,bold][{name}]#[default] "
            tab_separator           ""
          }
        }
        children
      }
    }
  '';
  
  zellijConfig = ''
        // zellij config matching tmux setup
        
        // theme
        theme "custom"
        themes {
          custom {
            fg "#c2c2c2"
            bg "#101010"
            black "#101010"
            red "#dc2626"
            green "#6b7280"
            yellow "#f97316"
            blue "#374151"
            magenta "#d1d5db"
            cyan "#6b7280"
            white "#c2c2c2"
            orange "#FFC799"
          }
        }

        // ui
        simplified_ui true
        pane_frames false
        default_layout "minimal"
        
        // mouse
        mouse_mode true
        
        // copy mode (vim-like)
        copy_command "${copyCommand}"
        
        keybinds clear-defaults=true {
          // leader key mode (like tmux prefix)
          normal {
            // tmux-style navigation without prefix
            bind "Ctrl h" { MoveFocusOrTab "Left"; }
            bind "Ctrl j" { MoveFocusOrTab "Down"; }
            bind "Ctrl k" { MoveFocusOrTab "Up"; }
            bind "Ctrl l" { MoveFocusOrTab "Right"; }
            
            // window navigation without prefix (ctrl+tab, ctrl+shift+tab)
            bind "Ctrl Tab" { GoToNextTab; }
            bind "Ctrl Shift Tab" { GoToPreviousTab; }
            
            // direct window selection (ctrl+1-9)
            bind "Ctrl 1" { GoToTab 1; }
            bind "Ctrl 2" { GoToTab 2; }
            bind "Ctrl 3" { GoToTab 3; }
            bind "Ctrl 4" { GoToTab 4; }
            bind "Ctrl 5" { GoToTab 5; }
            bind "Ctrl 6" { GoToTab 6; }
            bind "Ctrl 7" { GoToTab 7; }
            bind "Ctrl 8" { GoToTab 8; }
            bind "Ctrl 9" { GoToTab 9; }
            
            // new window without prefix
            bind "Ctrl t" { NewTab; }
            
            // close window without prefix (with confirmation)
            bind "Ctrl w" { CloseTab; }
            
            // close session without prefix (ctrl+shift+w)
            bind "Ctrl Shift w" { Quit; }
            
            // enter leader mode (tmux prefix equivalent: ctrl+space)
            bind "Ctrl Space" { SwitchToMode "tmux"; }
          }
          
          // tmux prefix mode (ctrl+space then command)
          tmux {
            // navigation with prefix (h/j/k/l like tmux)
            bind "h" { MoveFocus "Left"; SwitchToMode "Normal"; }
            bind "j" { MoveFocus "Down"; SwitchToMode "Normal"; }
            bind "k" { MoveFocus "Up"; SwitchToMode "Normal"; }
            bind "l" { MoveFocus "Right"; SwitchToMode "Normal"; }
            bind "Left" { MoveFocus "Left"; SwitchToMode "Normal"; }
            bind "Down" { MoveFocus "Down"; SwitchToMode "Normal"; }
            bind "Up" { MoveFocus "Up"; SwitchToMode "Normal"; }
            bind "Right" { MoveFocus "Right"; SwitchToMode "Normal"; }
            
            // tab navigation with prefix
            bind "Tab" { GoToNextTab; SwitchToMode "Normal"; }
            bind "Shift Tab" { GoToPreviousTab; SwitchToMode "Normal"; }
            
            // window selection with prefix (1-9)
            bind "1" { GoToTab 1; SwitchToMode "Normal"; }
            bind "2" { GoToTab 2; SwitchToMode "Normal"; }
            bind "3" { GoToTab 3; SwitchToMode "Normal"; }
            bind "4" { GoToTab 4; SwitchToMode "Normal"; }
            bind "5" { GoToTab 5; SwitchToMode "Normal"; }
            bind "6" { GoToTab 6; SwitchToMode "Normal"; }
            bind "7" { GoToTab 7; SwitchToMode "Normal"; }
            bind "8" { GoToTab 8; SwitchToMode "Normal"; }
            bind "9" { GoToTab 9; SwitchToMode "Normal"; }
            
            // new window with prefix
            bind "t" { NewTab; SwitchToMode "Normal"; }
            
            // close window with prefix
            bind "w" { CloseTab; SwitchToMode "Normal"; }
            
            // close session with prefix
            bind "W" { Quit; }
            
            // kill server equivalent
            bind "q" { Quit; }
            
            // split panes (bonus features)
            bind "|" { NewPane "Right"; SwitchToMode "Normal"; }
            bind "-" { NewPane "Down"; SwitchToMode "Normal"; }
            
            // back to normal
            bind "Esc" { SwitchToMode "Normal"; }
            bind "Ctrl Space" { SwitchToMode "Normal"; }
          }
          
          // minimal locked mode (like tmux locked)
          locked {
            bind "Ctrl Space" { SwitchToMode "Normal"; }
          }
        }
      '';
in
{
  home-manager.users.bdsqqq = { pkgs, ... }: {
    programs.zellij = {
      enable = true;
      enableZshIntegration = true;
    };

    home.file.".config/zellij/config.kdl" = {
      force = true;
      text = zellijConfig;
    };
    
    home.file.".config/zellij/layouts/minimal.kdl" = {
      force = true;
      text = zellijLayoutConfig;
    };
  };
}
