{ lib, pkgs }:
let
  evaluate = modules: (lib.evalModules {
    specialArgs = { inherit pkgs; hostSystem = "aarch64-darwin"; };
    modules = [
      {
        options = {
          assertions = lib.mkOption { type = lib.types.listOf lib.types.anything; default = [ ]; };
          home-manager = lib.mkOption { type = lib.types.attrs; default = { }; };
          networking = lib.mkOption { type = lib.types.attrs; default.localHostName = "ssd-fixture"; };
          my.primaryUser = lib.mkOption { type = lib.types.str; default = "fixture"; };
          my.paths.commonplace = lib.mkOption { type = lib.types.str; default = "/tmp/commonplace"; };
          sops.secrets = lib.mkOption {
            default = { };
            type = lib.types.attrsOf (lib.types.submodule ({ name, ... }: {
              options = {
                path = lib.mkOption { type = lib.types.str; default = "/run/secrets/${name}"; };
                owner = lib.mkOption { type = lib.types.str; };
                mode = lib.mkOption { type = lib.types.str; };
                sopsFile = lib.mkOption { type = lib.types.path; };
              };
            }));
          };
        };
        config.home-manager.users.fixture.home.homeDirectory = "/tmp/fixture-home";
        config.home-manager.users.bdsqqq.home.homeDirectory = "/tmp/fixture-home";
      }
    ] ++ modules;
  }).config;
  dormant = evaluate [ ./credential.nix ];
  cfg = evaluate [ ./default.nix {
    imports = [ ../terraria ];
    my.backup.terraria.saveRoot = "/tmp/game";
    my.ssd01Backup = { sshKeyPath = "/tmp/host-identity"; knownHostsPath = "/tmp/trusted-hosts"; };
  } ];
  onlyTerraria = evaluate [ ../terraria { my.backup.terraria.saveRoot = "/tmp/game"; } ];
  secret = cfg.sops.secrets.restic_ssd_01_password;
  repo = builtins.head cfg.my.backup.generated.repos;
  terraria = builtins.head (builtins.filter (plan: plan.id == "terraria") cfg.my.backup.generated.plans);
  rejectsPath = path: !(builtins.tryEval (builtins.deepSeq
    (evaluate [ ./default.nix { my.ssd01Backup.sshKeyPath = path; } ]).my.backup.generated true)).success;
in
assert dormant.sops.secrets == { };
assert builtins.attrNames onlyTerraria.my.backup.plans == [ "terraria" ];
assert onlyTerraria.my.backup.enable;
assert map (plan: plan.id) onlyTerraria.my.backup.generated.plans == [ "terraria" ];
assert (builtins.head onlyTerraria.my.backup.generated.plans).paths == [
  "/tmp/game/Players" "/tmp/game/Worlds"
];
assert !lib.hasInfix "/Volumes/ssd-01" (builtins.toJSON onlyTerraria.my.backup.generated);
assert onlyTerraria.my.restic.ssd01.credential.required;
assert onlyTerraria.sops.secrets.restic_ssd_01_password.sopsFile == ./secrets.yaml;
assert cfg.my.restic.ssd01.credential.required;
assert builtins.attrNames cfg.sops.secrets == [ "restic_ssd_01_password" ];
assert secret.owner == "fixture" && secret.mode == "0400";
assert secret.sopsFile == ./secrets.yaml;
assert repo.env == [ "RESTIC_PASSWORD_FILE=/run/secrets/restic_ssd_01_password" ];
assert repo.guid == (builtins.fromJSON (builtins.readFile ./drive.json)).repository.guid;
assert !repo.autoInitialize;
assert terraria.repo == repo.id;
assert terraria.schedule.maxFrequencyHours == 1;
assert builtins.all (hook: !lib.hasInfix "backup/ssd-01" hook.actionCommand.command) terraria.hooks;
assert lib.hasInfix "-i /tmp/host-identity" (builtins.head repo.flags);
assert lib.hasInfix "UserKnownHostsFile=/tmp/trusted-hosts" (builtins.head repo.flags);
assert rejectsPath "relative" && rejectsPath "/nix/store/private-key";
assert builtins.all (item: item.assertion) cfg.assertions;
cfg.my.backup.package
