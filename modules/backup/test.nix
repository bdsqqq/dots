{ lib, pkgs }:
let
  evaluateWith = settings: extra:
    (lib.evalModules {
      specialArgs = { inherit pkgs; hostSystem = "aarch64-darwin"; };
      modules = [
        ./default.nix
        {
          options = {
            assertions = lib.mkOption { type = lib.types.listOf lib.types.anything; default = [ ]; };
            home-manager = lib.mkOption { type = lib.types.attrs; default = { }; };
            networking = lib.mkOption { type = lib.types.attrs; };
          };
          config = {
            networking.localHostName = "fixture";
            my.backup = {
              homeDirectory = "/tmp/backup-fixture";
            } // settings;
          };
        }
      ] ++ extra;
    }).config;
  evaluate = settings: evaluateWith settings [ ];
  common = {
    defaultRepository = "local";
    repositories.local = {
      uri = "/tmp/repository";
      guid = "fixture";
      passwordFile = "/tmp/password";
      env = [ "RESTIC_COMPRESSION=off" ];
    };
  };
  ordinary = evaluate (common // { plans.documents.paths = "/tmp/documents"; });
  custom = evaluate (common // {
    repositories = common.repositories // {
      remote = { uri = "sftp:example:/backups"; guid = "fixture"; passwordCommand = "read-secret"; };
    };
    plans = {
      hourly = { paths = [ "/tmp/game" ]; schedule = { maxFrequencyHours = 1; clock = "CLOCK_LAST_RUN_TIME"; }; };
      daily = { paths = [ "/tmp/other" ]; schedule = { cron = "0 22 * * *"; clock = "CLOCK_LAST_RUN_TIME"; }; repository = "remote"; };
      skip = { paths = "/tmp/skip"; schedule = { cron = "5 0 * * *"; clock = "CLOCK_LOCAL"; }; };
      weekly = { paths = "/tmp/weekly"; schedule = { maxFrequencyDays = 7; clock = "CLOCK_LAST_RUN_TIME"; }; };
      manual = { paths = [ "/tmp/manual" ]; schedule.disabled = true; retention.policyKeepLastN = 10; };
      empty = { paths = "/tmp/empty"; schedule = { }; };
      utc = { paths = "/tmp/utc"; schedule = { cron = "0 22 * * *"; clock = "CLOCK_UTC"; }; };
    };
  });
  disabled = evaluate { };
  noDestination = evaluate { plans.bad.paths = "/tmp/game"; };
  unknownDestination = evaluate (common // { plans.bad = { paths = "/tmp/game"; repository = "absent"; }; });
  emptyPaths = evaluate (common // { plans.bad.paths = [ ]; });
  conflictingSecrets = evaluate (common // {
    repositories.local = common.repositories.local // { passwordCommand = "read-secret"; };
    plans.bad.paths = "/tmp/game";
  });
  storeSecret = evaluate (common // {
    repositories.local = { uri = "/tmp/repo"; passwordFile = "/nix/store/plaintext"; };
    plans.bad.paths = "/tmp/game";
  });
  missingGuid = evaluate (common // {
    repositories.local = { uri = "/tmp/repo"; passwordFile = "/tmp/password"; };
    plans.bad.paths = "/tmp/game";
  });
  initialize = evaluate (common // {
    repositories.local = { uri = "/tmp/repo"; passwordFile = "/tmp/password"; autoInitialize = true; };
    plans.new.paths = "/tmp/game";
  });
  conflictingIdentity = evaluate (common // {
    repositories.local = common.repositories.local // { autoInitialize = true; };
    plans.bad.paths = "/tmp/game";
  });
  valid = cfg: builtins.all (item: item.assertion) cfg.assertions;
  plan = id: cfg: builtins.head (builtins.filter (item: item.id == id) cfg.my.backup.generated.plans);
  rejectsType = settings:
    !(builtins.tryEval (builtins.deepSeq (evaluate settings).my.backup.generated true)).success;
in
assert valid ordinary && valid custom;
assert (builtins.head ordinary.my.backup.generated.repos).env == [
  "RESTIC_COMPRESSION=off"
  "RESTIC_PASSWORD_FILE=/tmp/password"
];
assert (builtins.head (builtins.filter (repo: repo.id == "remote") custom.my.backup.generated.repos)).env == [
  "RESTIC_PASSWORD_COMMAND=read-secret"
];
assert !valid noDestination && !valid unknownDestination && !valid emptyPaths;
assert !valid conflictingSecrets && !valid storeSecret;
assert !valid missingGuid && valid initialize;
assert !valid conflictingIdentity;
assert rejectsType (common // { plans.bad.paths = "relative"; });
assert rejectsType (common // { plans.bad = { paths = "/tmp/game"; schedule = 0; }; });
assert builtins.all (schedule: rejectsType (common // { plans.bad = { paths = "/tmp/game"; inherit schedule; }; })) [
  1 null "0 3 * * *" "manual"
  { every = "1h"; } { dailyAt = "22:00"; } { timeZone = "UTC"; } { missedRun = "skip"; }
  { maxFrequencyHours = 0; } { maxFrequencyDays = -1; }
  { maxFrequencyHours = 1.5; } { maxFrequencyDays = 2147483648; }
  { maxFrequencyHours = "1"; } { disabled = false; } { cron = ""; }
  { cron = "0 22 * * *"; maxFrequencyHours = 1; }
  { disabled = true; cron = "0 22 * * *"; }
  { maxFrequencyHours = 1; maxFrequencyDays = 1; }
  { cron = "0 22 * * *"; clock = "UTC"; }
];
assert !(builtins.tryEval (builtins.deepSeq
  (evaluateWith (common // { plans.bad = { paths = "/tmp/game"; schedule.cron = "0 22 * * *"; }; })
    [ { my.backup.plans.bad.schedule.maxFrequencyHours = 1; } ]).my.backup.generated true)).success;
assert disabled.home-manager == { };
assert (plan "documents" ordinary).paths == [ "/tmp/documents" ];
assert (plan "documents" ordinary).repo == "local";
assert (plan "documents" ordinary).schedule.maxFrequencyHours == 24;
assert (plan "documents" ordinary).retention == { policyKeepAll = true; };
assert (plan "hourly" custom).schedule.maxFrequencyHours == 1;
assert (plan "daily" custom).schedule == { cron = "0 22 * * *"; clock = "CLOCK_LAST_RUN_TIME"; };
assert (plan "daily" custom).repo == "remote";
assert (plan "skip" custom).schedule == { cron = "5 0 * * *"; clock = "CLOCK_LOCAL"; };
assert (plan "weekly" custom).schedule == { maxFrequencyDays = 7; clock = "CLOCK_LAST_RUN_TIME"; };
assert (plan "manual" custom).schedule == { disabled = true; clock = "CLOCK_DEFAULT"; };
assert (plan "empty" custom).schedule == { clock = "CLOCK_DEFAULT"; };
assert (plan "utc" custom).schedule == { cron = "0 22 * * *"; clock = "CLOCK_UTC"; };
assert (plan "manual" custom).retention == { policyKeepLastN = 10; };
assert (builtins.head (plan "hourly" custom).hooks).onError == "ON_ERROR_CANCEL";
assert lib.hasInfix "/tmp/game" (builtins.head (plan "hourly" custom).hooks).actionCommand.command;
assert !lib.hasInfix "diskutil" (builtins.head (plan "hourly" custom).hooks).actionCommand.command;
true
