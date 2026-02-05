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

    };
    home.packages = with pkgs; [
      coreutils
      exiftool
      sops
      age
      ssh-to-age
      fnm
      pnpm
      pscale
      go

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
      ollama
      mkcert
      trash-cli
    ] ++ lib.optionals isDarwin [
    istat-menus
] ++ lib.optionals (!isDarwin) [
    nvtopPackages.full
    radeontop
];

    home.shellAliases = {
      b = "btop";
      f = "fastfetch";
    };
  };
}
