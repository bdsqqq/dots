{ lib, inputs, hostSystem ? null, config ? {}, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  homeDir = if isDarwin then "/Users/bdsqqq" else "/home/bdsqqq";
in
{
  sops.templates."opencode.json" = {
    content = builtins.toJSON {
      "$schema" = "https://opencode.ai/config.json";
      autoupdate = false;

      permission = {
        "*" = "allow";
        bash = {
          "*" = "allow";
          "git add -A*" = "deny";
          "git add .*" = "deny";
          "git push --force*" = "deny";
          "git push -f*" = "deny";
          "*--force-with-lease*" = "deny";
          "rm *" = "deny";
        };
      };

      provider = {
        opencode = {
          options = {
            apiKey = config.sops.placeholder.opencode_zen;
          };
        };
        openrouter = {
          options = {
            apiKey = config.sops.placeholder.open_router;
          };
        };
      };

      mcp = {
        motion = {
          type = "local";
          command = [
            "npx"
            "-y"
            "https://api.motion.dev/registry.tgz?package=motion-studio-mcp&version=latest&token=${config.sops.placeholder.motion_plus_token}"
          ];
        };
      };
    };
    owner = "bdsqqq";
    mode = "0600";
  };

  home-manager.users.bdsqqq = { pkgs, config, lib, ... }: {
    home.file.".config/opencode/opencode.json".source = config.lib.file.mkOutOfStoreSymlink "/run/secrets/rendered/opencode.json";
  };
}
