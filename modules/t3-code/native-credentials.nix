{ config, lib, pkgs, ... }:
let
  cfg = config.my.t3Code.credentialSync;
  repo = "${config.my.paths.commonplace}/01_files/nix/modules/t3-code";
  home = config.users.users.bdsqqq.home;
  # the claude token stays with claude-pi; the launcher only reads service.env.
  secrets = builtins.mapAttrs (_: secret: secret.path)
    (builtins.removeAttrs config.sops.secrets [ "claude_code_oauth_token" ])
  // builtins.mapAttrs (name: value: "${pkgs.writeText "t3-env-${name}" value}") cfg.environment;
  manifest = pkgs.writeText "t3-credentials.json" (builtins.toJSON {
    home = "${home}/.t3";
    inherit secrets;
  });
  command = [ "${pkgs.nodejs_latest}/bin/node" "${repo}/sync-credentials.ts" "${manifest}" ];
in
{
  options.sops.secrets = lib.mkOption {
    type = lib.types.attrsOf (lib.types.submodule {
      config.owner = lib.mkIf cfg.enable (lib.mkForce "bdsqqq");
    });
  };

  options.my.t3Code.credentialSync = {
    enable = lib.mkEnableOption "credential synchronization into native T3 service.env";
    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Non-secret values for the native T3 service environment.";
    };
  };

  config = lib.mkIf cfg.enable {
    # Darwin provisions SOPS secrets after home-manager; sync only after both.
    system.activationScripts.postActivation.text = lib.mkOrder 2000 ''
      /bin/launchctl asuser "$(/usr/bin/id -u bdsqqq)" /usr/bin/sudo -u bdsqqq --set-home -- ${lib.escapeShellArgs command}
    '';
    home-manager.users.bdsqqq = { config, lib, ... }: {
      home.file.".config/t3-code/credentials.json".source = manifest;
      home.file.".local/bin/t3-sync-credentials".source =
        config.lib.file.mkOutOfStoreSymlink "${repo}/sync-credentials.ts";
      launchd.agents.t3-credential-sync.enable = true;
      launchd.agents.t3-credential-sync.config = {
        ProgramArguments = command;
        RunAtLoad = true;
        StartInterval = 60;
        WatchPaths = lib.unique (builtins.attrValues secrets);
        ProcessType = "Background";
        StandardOutPath = "${home}/Library/Logs/t3-credential-sync.log";
        StandardErrorPath = "${home}/Library/Logs/t3-credential-sync-error.log";
      };
    };
  };
}
