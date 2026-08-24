{ inputs
, lib
, ...
}:
let
  stateDirectory = "/var/lib/household-intake/vm";
  runner = inputs.self.nixosConfigurations.household-storage.config.microvm.declaredRunner;
in
{
  system.activationScripts.preActivation.text = lib.mkAfter ''
    install -d -m 0700 -o root -g wheel ${stateDirectory}
  '';

  launchd.daemons.household-storage = {
    command = "${runner}/bin/microvm-run";
    serviceConfig = {
      Label = "dev.household-intake.storage-vm";
      RunAtLoad = true;
      KeepAlive = true;
      ProcessType = "Background";
      WorkingDirectory = stateDirectory;
      ThrottleInterval = 10;
      StandardOutPath = "/var/log/household-storage-vm.log";
      StandardErrorPath = "/var/log/household-storage-vm.log";
    };
  };
}
