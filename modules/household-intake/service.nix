{ config
, inputs
, lib
, pkgs
, ...
}:
let
  cfg = config.my.householdIntake.storageVm;
  stateDirectory = "/var/lib/household-intake/vm";
  runner = inputs.self.nixosConfigurations.household-storage.config.microvm.declaredRunner;
  supervisor = pkgs.writeShellScript "household-storage-vm" ''
    set -uo pipefail

    vmPid=
    stop() {
      trap - TERM INT
      if [[ -n "$vmPid" ]] && kill -0 "$vmPid" 2>/dev/null; then
        if ! ${lib.getExe pkgs.curl} --silent --show-error --fail --max-time 5 \
          --unix-socket household-storage.sock \
          --header 'Content-Type: application/json' \
          --data '{"state":"Stop"}' \
          http://localhost/vm/state; then
          kill -TERM "$vmPid"
        fi
        wait "$vmPid"
      fi
      exit 0
    }
    trap stop TERM INT

    ${runner}/bin/microvm-run &
    vmPid=$!
    wait "$vmPid"
    status=$?
    vmPid=
    exit "$status"
  '';
in
{
  options.my.householdIntake.storageVm.enable = lib.mkEnableOption
    "the household storage microVM";

  config = lib.mkIf cfg.enable {
    system.activationScripts.preActivation.text = lib.mkAfter ''
      install -d -m 0700 -o root -g wheel ${stateDirectory}
    '';

    launchd.daemons.household-storage = {
      command = supervisor;
      serviceConfig = {
        Label = "dev.household-intake.storage-vm";
        RunAtLoad = true;
        KeepAlive = true;
        ProcessType = "Background";
        WorkingDirectory = stateDirectory;
        ThrottleInterval = 10;
        ExitTimeOut = 60;
        StandardOutPath = "/var/log/household-storage-vm.log";
        StandardErrorPath = "/var/log/household-storage-vm.log";
      };
    };
  };
}
