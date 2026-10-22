# Evaluation-only source fixture: this file is not an encrypted credential.
{ lib }:
let
  evaluate = settings: (lib.evalModules {
    modules = [
      ./default.nix
      # Multiple consumers may import the owner directly or through the module.
      ./credential.nix
      ({ lib, ... }: {
        options.assertions = lib.mkOption {
          type = lib.types.listOf lib.types.raw;
          default = [ ];
        };
        options.sops.secrets = lib.mkOption {
          type = lib.types.attrsOf lib.types.attrs;
          default = { };
        };
      })
      settings
    ];
  }).config;
  valid = cfg: builtins.all (assertion: assertion.assertion) cfg.assertions;
  dormant = evaluate { my.jev.credential.sopsFile = null; };
  missing = evaluate { my.jev.credential = { required = true; sopsFile = null; }; };
  configured = evaluate { my.jev.credential = { required = true; sopsFile = ./test.nix; }; };
  retained = evaluate { my.jev.credential.sopsFile = ./test.nix; };
in
assert valid dormant && dormant.sops.secrets == { };
assert valid retained && retained.sops.secrets == { };
assert !(valid missing) && missing.sops.secrets == { };
assert valid configured;
assert builtins.attrNames configured.sops.secrets == [ "jev_api_key" ];
assert configured.sops.secrets.jev_api_key.sopsFile == ./test.nix;
assert configured.sops.secrets.jev_api_key.owner == "bdsqqq";
assert configured.sops.secrets.jev_api_key.mode == "0400";
{ passed = true; }
