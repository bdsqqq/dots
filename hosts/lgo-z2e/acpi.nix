{ config, pkgs, ... }:

{
  # Centralize privileged hardware writes used by the handheld shell.
  # Quickshell should trigger these through systemd/polkit instead of writing
  # sysfs or ACPI directly from the user session.

  boot.extraModulePackages = [ config.boot.kernelPackages.acpi_call ];
  boot.kernelModules = [ "acpi_call" ];

  # templated service: systemctl start amdgpu-profile@{low,auto,high}.service
  systemd.services."amdgpu-profile@" = {
    description = "Set AMDGPU power profile to %i";
    serviceConfig = {
      Type = "oneshot";
      ExecStart =
        "${pkgs.bash}/bin/bash -c 'echo %i > /sys/class/drm/card1/device/power_dpm_force_performance_level'";
    };
  };

  # templated service: systemctl start ryzenadj-tdp@{8,15,25,30}.service (values in watts)
  systemd.services."ryzenadj-tdp@" = {
    description = "Set CPU TDP to %i watts via ryzenadj";
    serviceConfig = {
      Type = "oneshot";
      ExecStart =
        "${pkgs.bash}/bin/bash -c '${pkgs.ryzenadj}/bin/ryzenadj --stapm-limit=%i000 --fast-limit=%i000 --slow-limit=%i000'";
    };
  };

  # allow the shell user to start only the hardware-control units it presents.
  security.polkit.extraConfig = ''
    polkit.addRule(function(action, subject) {
      if (action.id == "org.freedesktop.systemd1.manage-units" &&
          (action.lookup("unit").indexOf("amdgpu-profile@") == 0 ||
           action.lookup("unit").indexOf("ryzenadj-tdp@") == 0) &&
          subject.user == "bdsqqq") {
        return polkit.Result.YES;
      }
    });
  '';
}
