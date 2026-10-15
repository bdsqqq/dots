# Isolated module contracts, not decryption, host closure or runtime evidence.
{ lib }:
let
  evaluate = darwin: settings: (lib.evalModules {
    specialArgs.pkgs.stdenv = { isDarwin = darwin; isLinux = !darwin; };
    modules = [
      ./default.nix ../goplaces/default.nix
      ({ lib, ... }: {
        options.assertions = lib.mkOption { type = lib.types.listOf lib.types.raw; default = []; };
        options.home-manager.users = lib.mkOption { type = lib.types.attrsOf lib.types.raw; default = {}; };
        options.my.paths.commonplace = lib.mkOption { type = lib.types.str; default = "/fixture/live"; };
        options.sops.secrets = lib.mkOption {
          default = {};
          type = lib.types.attrsOf (lib.types.submodule ({ name, ... }: {
            options = {
              path = lib.mkOption { type = lib.types.str; default = "/run/secrets/${name}"; };
              sopsFile = lib.mkOption { type = lib.types.path; };
              owner = lib.mkOption { type = lib.types.str; };
              mode = lib.mkOption { type = lib.types.str; };
            };
          }));
        };
      })
      settings
    ];
  }).config;
  valid = cfg: builtins.all (a: a.assertion) cfg.assertions;
  # This existing source file is deliberately an evaluation-only fixture, not
  # an encrypted credential or a deployable provisioning example.
  configured = { my.gog = { enable = true; account = "fixture@example.test"; client = "fixture"; credential.sopsFile = ./auth-eval.nix; }; };
  linux = evaluate false configured;
  mac = evaluate true configured;
  packageOnly = evaluate true {};
  # A package-only consumer must not veto another consumer's credential need.
  retained = evaluate true {
    my.gog.credential = { required = true; sopsFile = ./auth-eval.nix; };
    my.goplaces.credential = { required = true; sopsFile = ./auth-eval.nix; };
  };
in
assert valid packageOnly;
assert packageOnly.sops.secrets == {};
assert valid retained && builtins.attrNames retained.sops.secrets == [ "gog_oauth_client" "google_places_api_key" ];
assert !(valid (evaluate true { my.gog.enable = true; }));
# Force absence: this negative must not depend on whether real credentials exist.
assert !(valid (evaluate true { my.gog = { enable = true; account = "fixture@example.test"; client = "fixture"; credential.sopsFile = null; }; }));
assert !(valid (evaluate true (lib.recursiveUpdate configured { my.gog.account = null; })));
assert !(valid (evaluate true (lib.recursiveUpdate configured { my.gog.services = []; })));
assert !(valid (evaluate false (lib.recursiveUpdate configured { my.gog.keyringBackend = "keychain"; })));
assert valid linux && builtins.hasAttr "gog_keyring_password" linux.sops.secrets;
assert valid mac && !(builtins.hasAttr "gog_keyring_password" mac.sops.secrets);
assert !(valid (evaluate true { my.goplaces.enable = true; }));
assert !(valid (evaluate true { my.goplaces.apiKeyFile = "relative"; }));
assert !(valid (evaluate true { my.goplaces.apiKeyFile = "/nix/store/fixture"; }));
assert valid (evaluate true { my.goplaces = { enable = true; apiKeyFile = "/private/external-key"; }; });
assert valid (evaluate true { my.goplaces = { enable = true; credential.sopsFile = ./auth-eval.nix; }; });
{ passed = true; }
