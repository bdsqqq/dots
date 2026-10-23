{ config, lib, pkgs, ... }:
let
  cfg = config.my.gog;
  live = "${config.my.paths.commonplace}/01_files/nix/modules/gog/auth.ts";
  credentialPath = name: if builtins.hasAttr name config.sops.secrets then config.sops.secrets.${name}.path else "";
  env = lib.concatStringsSep "\n" (lib.mapAttrsToList (name: value: "export ${name}=${lib.escapeShellArg value}") {
    TOOL_AUTH_GOG_ENABLED = if cfg.enable then "1" else "0";
    TOOL_AUTH_GOG_ACCOUNT = if cfg.account == null then "" else cfg.account;
    TOOL_AUTH_GOG_CLIENT = if cfg.client == null then "" else cfg.client;
    TOOL_AUTH_GOG_SERVICES = lib.concatStringsSep "," cfg.services;
    TOOL_AUTH_GOG_BACKEND = cfg.keyringBackend;
    TOOL_AUTH_GOG_CLIENT_FILE = if cfg.enable then credentialPath "gog_oauth_client" else "";
    TOOL_AUTH_GOG_PASSWORD_FILE = if cfg.enable && cfg.keyringBackend == "file" then credentialPath "gog_keyring_password" else "";
    TOOL_AUTH_GOG_BINARY = "${pkgs.gogcli}/bin/gog";
  });
  auth = pkgs.writeShellScriptBin "gog-auth" ''
    ${env}
    exec ${pkgs.nodejs_latest}/bin/node ${lib.escapeShellArg live} "$@"
  '';
  wrapped = pkgs.writeShellScriptBin "gog" ''
    exec ${auth}/bin/gog-auth run "$@"
  '';
in {
  imports = [ ./credential.nix ];
  options.my.gog = {
    enable = lib.mkEnableOption "authenticated Gmail/Calendar integration (false installs only the package)";
    account = lib.mkOption { type = lib.types.nullOr lib.types.str; default = null; description = "Explicit expected Google account email; never inferred."; };
    client = lib.mkOption { type = lib.types.nullOr lib.types.str; default = null; description = "Explicit named gog OAuth client, including default if intentional."; };
    services = lib.mkOption { type = lib.types.listOf (lib.types.enum [ "gmail" "calendar" ]); default = [ "gmail" "calendar" ]; description = "Services that readiness must authenticate."; };
    keyringBackend = lib.mkOption { type = lib.types.enum [ "file" "keychain" ]; default = if pkgs.stdenv.isDarwin then "keychain" else "file"; description = "Native Keychain on macOS or SOPS-password-backed unattended file keyring."; };
  };
  config = {
    my.gog.credential.required = lib.mkIf cfg.enable true;
    my.gog.credential.passwordRequired = lib.mkIf (cfg.enable && cfg.keyringBackend == "file") true;
    assertions = [
      { assertion = !cfg.enable || (cfg.account != null && builtins.match "[^[:space:]@]+@[^[:space:]@]+" cfg.account != null); message = "gog auth requires an explicit my.gog.account email."; }
      { assertion = !cfg.enable || (cfg.client != null && builtins.match "[a-z0-9_-]+" cfg.client != null); message = "gog auth requires an explicit normalized my.gog.client name."; }
      { assertion = !cfg.enable || cfg.services != []; message = "gog auth requires at least one declared Gmail/Calendar service."; }
      { assertion = !cfg.enable || !pkgs.stdenv.isLinux || cfg.keyringBackend == "file"; message = "unattended Linux gog auth requires the file keyring and its SOPS password."; }
    ];
    home-manager.users.bdsqqq = { ... }: {
      home.packages = [ (if cfg.enable then wrapped else pkgs.gogcli) auth ];
      # No activation writes: native credentials, tokens and keyrings stay writable.
    };
  };
}
