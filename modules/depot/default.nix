{ config, lib, pkgs, hostSystem, ... }:
let
  cfg = config.my.depot;
  isDarwin = lib.hasSuffix "-darwin" hostSystem;
  source = "${config.my.paths.commonplace}/01_files/nix/modules/depot/auth.ts";
  secret = if cfg.credential.required then config.sops.secrets.depot_org_token.path else "";
  wrapper = pkgs.writeShellScriptBin "depot-org" ''
    exec ${pkgs.nodejs_24}/bin/node ${lib.escapeShellArg source} ${lib.escapeShellArgs [
      cfg.executable secret (if cfg.organizationId == null then "" else cfg.organizationId)
      config.home-manager.users.bdsqqq.xdg.configHome
    ]} "$@"
  '';
in
{
  imports = [ ./credential.nix ];

  options.my.depot = {
    organizationId = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Explicit organization for depot-org; native CLI selection is not changed.";
    };
    executable = lib.mkOption {
      type = lib.types.str;
      default = if isDarwin then "${config.homebrew.prefix}/bin/depot" else "depot";
      description = "Native Depot CLI executable; non-Darwin consumers must supply its installation.";
    };
  };

  config = lib.mkMerge [
    (lib.optionalAttrs isDarwin {
      homebrew.taps = [ "depot/tap" ];
      homebrew.brews = [ "depot" ];
    })
    {
      assertions = [{
        assertion = !cfg.credential.required || (cfg.organizationId != null && builtins.match "[a-z0-9]+" cfg.organizationId != null);
        message = "depot-org requires an explicit my.depot.organizationId.";
      }];
      # no native config/token writes or shell-wide exports: user login stays user-owned.
      home-manager.users.bdsqqq.home.packages = lib.optionals cfg.credential.required [ wrapper ];
    }
  ];
}
