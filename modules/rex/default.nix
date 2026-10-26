{ config, lib, inputs, hostSystem, headMode ? "graphical", ... }:
let
  isLinux = lib.hasInfix "linux" hostSystem;
  isDarwin = lib.hasInfix "darwin" hostSystem;
  repoConfig = "${config.my.paths.commonplace}/01_files/nix/modules/rex/config";
in
{
  imports = [ ./credential.nix ] ++ lib.optionals isLinux [
    inputs.rex.nixosModules.default
  ];

  config = lib.mkMerge [
    {
      # macs also evaluate the linux fleet (ssh config) and fetch this flake input.
      my.rex.credential.required = true;
      nix.settings.netrc-file = config.sops.secrets.rex_netrc.path;
    }
    (lib.optionalAttrs isLinux {
      # reuse host tailscaled identity; no embedded node, public TCP, or anonymous access.
      services.rex.loginServer = {
        enable = true;
        accounts.bdsqqq.principals = [ "tailscale:igorbedesqui@gmail.com" ];
        defaults."tailscale:igorbedesqui@gmail.com" = "bdsqqq";
        tailscaleServe.enable = config.services.tailscale.enable;
      };
    })
    (lib.optionalAttrs (headMode == "graphical" && isDarwin) {
      home-manager.users.bdsqqq = { config, ... }: {
        xdg.configFile."rex".source = config.lib.file.mkOutOfStoreSymlink repoConfig;
      };
    })
  ];
}
