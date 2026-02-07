{ ... }:
{
  home-manager.users.bdsqqq = { pkgs, ... }: {
    programs.direnv = {
      enable = true;
      # nix-direnv caches nix devshell evaluations so entering a
      # flake project doesn't re-evaluate on every cd. without this,
      # direnv + nix is unusably slow.
      nix-direnv.enable = true;
      # nix devshells export hundreds of env vars; the default diff
      # output floods the terminal on every prompt.
      config.global.hide_env_diff = true;
    };
  };
}
