# Evaluation-only fixture, not an encrypted credential or decryption test.
{ lib }:
let
  evaluate =
    settings:
    (lib.evalModules {
      modules = [
        ./default.nix
        ./credential.nix
        ({ lib, ... }: {
          options.assertions = lib.mkOption {
            type = lib.types.listOf lib.types.raw;
            default = [ ];
          };
          options.home-manager.users = lib.mkOption {
            type = lib.types.attrsOf lib.types.raw;
            default = { };
          };
          options.my.paths.commonplace = lib.mkOption {
            type = lib.types.str;
            default = "/fixture/live";
          };
          options.sops.secrets = lib.mkOption {
            type = lib.types.attrsOf (
              lib.types.submodule (
                { name, ... }: {
                  options = {
                    path = lib.mkOption {
                      type = lib.types.str;
                      default = "/run/secrets/${name}";
                    };
                    sopsFile = lib.mkOption { type = lib.types.path; };
                    owner = lib.mkOption { type = lib.types.str; };
                    mode = lib.mkOption { type = lib.types.str; };
                  };
                }
              )
            );
            default = { };
          };
        })
        settings
      ];
    }).config;
  valid = cfg: builtins.all (a: a.assertion) cfg.assertions;
  dormant = evaluate { my.annasArchive.credential.sopsFile = null; };
  missing = evaluate {
    my.annasArchive = {
      enable = true;
      credential.sopsFile = null;
    };
  };
  configured = evaluate {
    my.annasArchive = {
      enable = true;
      credential.sopsFile = ./test.nix;
    };
  };
  external = evaluate {
    my.annasArchive = {
      enable = true;
      apiKeyFile = "/private/external-key";
      credential.sopsFile = null;
    };
  };
  otherConsumer = evaluate {
    my.annasArchive.credential = {
      required = true;
      sopsFile = ./test.nix;
    };
  };
in
assert valid dormant && dormant.sops.secrets == { };
assert
  dormant.my.annasArchive.preferencesFile
  == "/fixture/live/01_files/nix/modules/annas-archive/preferences.conf";
assert !(valid missing) && missing.sops.secrets == { };
assert valid external && external.sops.secrets == { };
assert valid otherConsumer;
assert valid configured;
assert builtins.attrNames configured.sops.secrets == [ "annas_archive_key" ];
assert configured.sops.secrets.annas_archive_key.sopsFile == ./test.nix;
assert configured.sops.secrets.annas_archive_key.owner == "bdsqqq";
assert configured.sops.secrets.annas_archive_key.mode == "0400";
assert builtins.all
  (
    path:
    !(valid (evaluate {
      my.annasArchive.apiKeyFile = path;
    }))
  )
  [
    "/"
    "relative"
    "/nix/store"
    "/nix/store/fixture"
  ];
assert builtins.all
  (
    url:
    !(valid (evaluate {
      my.annasArchive.baseUrl = url;
    }))
  )
  [
    "http://example.test"
    "https://user:pass@example.test"
    "https://example.test/path"
    "https://example.test?key=bad"
    "https://example.test#bad"
  ];
{
  passed = true;
}
