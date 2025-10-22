{ lib, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
in
{
  home-manager.users.bdsqqq = { pkgs, ... }: {
    programs = {
      yt-dlp = {
        enable = true;
        settings = { sub-lang = "en.*"; };
      };
      gallery-dl.enable = true;
      spotify-player.enable = true;
    };
    home.packages = with pkgs; [
      lazygit
      delta
      gh
      graphite-cli
      git-filter-repo
      exiftool
      sops
      age
      ssh-to-age
      fnm
      oh-my-zsh
      nodejs_22
      pnpm
      pscale
      go
      python3
      uv
      gofumpt
      golangci-lint
      gotools
      gopls
      gotests
      delve
      ripgrep
      ast-grep
      fd
      bat
      eza
      btop
      ctop
      lazydocker
      curl
      wget
      jq
      yq
      tree
      tailscale
      p7zip
      cloc
      stow
      yazi
      tmux
      ffmpeg
      httpie
      fastfetch
    ] ++ lib.optionals isDarwin [
    istat-menus
] ++ lib.optionals (!isDarwin) [
    nvtopPackages.nvidia
];
  };
}


