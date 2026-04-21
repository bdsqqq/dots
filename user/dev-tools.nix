{ config, lib, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  gpuVendors = lib.unique config.my.hardware.gpu.vendors;
  hasAmdGpu = lib.elem "amd" gpuVendors;
  hasIntelGpu = lib.elem "intel" gpuVendors;
  hasNvidiaGpu = lib.elem "nvidia" gpuVendors;
in
{
  options.my.hardware.gpu.vendors = lib.mkOption {
    type = with lib.types; listOf (enum [ "amd" "intel" "nvidia" ]);
    default = [ ];
    description = ''
      gpu vendors present on this host.

      `dev-tools.nix` uses an explicit capability list here instead of
      inferring from `headMode` or `torchBackend`, which describe session
      shape and python package selection rather than gpu monitor tooling.
    '';
  };

  config.home-manager.users.bdsqqq = { pkgs, ... }: {
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
    ] ++ lib.optionals isDarwin [
      istat-menus
    ] ++ lib.optionals hasAmdGpu [
      nvtopPackages.amd
      radeontop
    ] ++ lib.optionals hasIntelGpu [
      nvtopPackages.intel
    ] ++ lib.optionals hasNvidiaGpu [
      nvtopPackages.nvidia
    ];

    home.shellAliases = {
      b = "btop";
      f = "fastfetch";
    };
  };
}
