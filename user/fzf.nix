{ config, pkgs, ... }:
{
  home-manager.users.bdsqqq = { config, pkgs, ... }: {
    programs.fzf = {
      enable = true;
      # removed --follow: steam/flatpak dirs have broken symlinks that peg cpu
      # added globs to skip problematic dirs entirely
      defaultCommand = "rg --files --hidden --glob '!.steam' --glob '!.local/share/flatpak' --glob '!.local/share/Steam'";
      defaultOptions = [
        "--height=40%"
        "--layout=reverse"
        "--border"
      ];
    };

    programs.zsh.initExtra = ''
      # custom fzf file widget (ctrl+f)
      _fzf_files() {
        local selected=$(rg --files --hidden --glob '!.steam' --glob '!.local/share/flatpak' --glob '!.local/share/Steam' | fzf --height=40% --layout=reverse --border)
        LBUFFER="''${LBUFFER}''${selected}"
        zle reset-prompt
      }
      zle -N _fzf_files
      bindkey '^F' _fzf_files
    '';
  };
}
