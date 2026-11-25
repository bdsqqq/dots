# pkgs.unstable: the nixpkgs-unstable input, for the few packages a host pins
# ahead of the default set (kernels, neovim, tailscale).
inputs: final: prev: {
  unstable = import inputs.nixpkgs-unstable {
    inherit (final.stdenv.hostPlatform) system;
    config.allowUnfree = true;
  };
}
