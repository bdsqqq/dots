{
  config,
  lib,
  hostSystem ? "",
  ...
}:
# Shape uses an external argument: pkgs depends on module configuration.
# Linux receives no undeclared homebrew options, including inside mkIf.
lib.optionalAttrs (lib.hasInfix "darwin" hostSystem) (
  let
    cfg = config.my.remindctl.integration;
    source = "${config.my.paths.commonplace}/01_files/nix/modules/remindctl/ready.ts";
  in
  {
    options.my.remindctl.integration = {
      enable = lib.mkEnableOption "selected macOS Reminders integration";
      account = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Human account/store binding; EventKit cannot authenticate an Apple ID, so listId selects the intended list.";
      };
      listId = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Exact stable list ID from the intended EventKit account; no default/prefix selection.";
      };
    };
    config = {
      assertions = [
        {
          assertion =
            !cfg.enable || (cfg.account != null && cfg.account != "" && cfg.listId != null && cfg.listId != "");
          message = "remindctl integration requires explicit account and exact listId; TCC consent is native and explicit";
        }
      ];
      # Signed native binary requires macOS 14+ and process-specific EventKit permission.
      homebrew.taps = [ "steipete/tap" ];
      homebrew.brews = [{
        # Bundle cannot apply formula-scoped trust to an unqualified name.
        name = "steipete/tap/remindctl";
        trusted = true;
      }];
      home-manager.users.bdsqqq = { pkgs, ... }: {
        home.packages = [
          (pkgs.writeShellScriptBin "remindctl-ready" ''
            exec ${pkgs.nodejs}/bin/node --experimental-strip-types ${lib.escapeShellArg source} ${
              if hostSystem == "x86_64-darwin" then "/usr/local" else "/opt/homebrew"
            }/bin/remindctl ${
              lib.escapeShellArgs [
                (if cfg.enable then "1" else "0")
                (if cfg.account == null then "" else cfg.account)
                (if cfg.listId == null then "" else cfg.listId)
              ]
            } "$@"
          '')
        ];
      };
    };
  }
)
