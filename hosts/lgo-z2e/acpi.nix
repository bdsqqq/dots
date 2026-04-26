{ config, pkgs, ... }:

let
  fanCurveConfig = "/home/bdsqqq/commonplace/01_files/nix/hosts/lgo-z2e/fan-curve.json";
  legionAcpi = pkgs.writeShellApplication {
    name = "legion-acpi";
    runtimeInputs = [ pkgs.python3 ];
    text = ''
      exec python3 ${pkgs.writeText "legion-acpi.py" ''
        import json
        import sys

        ACPI_CALL = "/proc/acpi/call"
        WMAB = r"\_SB.GZFD.WMAB"
        POINTS_C = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
        MIN_CURVE = [44, 48, 55, 60, 71, 79, 87, 87, 100, 100]

        def acpi_call(method, args):
            command = method
            for arg in args:
                if isinstance(arg, int):
                    command += f" 0x{arg:02x}"
                else:
                    command += f" b{arg.hex()}"
            try:
                with open(ACPI_CALL, "wb") as f:
                    f.write(command.encode())
            except PermissionError:
                raise SystemExit(f"permission denied writing {ACPI_CALL}; run as root or through systemd")

        def acpi_read():
            try:
                with open(ACPI_CALL, "rb") as f:
                    raw = f.read().decode().strip()
            except PermissionError:
                raise SystemExit(f"permission denied reading {ACPI_CALL}; run as root or through systemd")
            if raw == "not called\0":
                raise SystemExit("acpi_call returned: not called")
            if raw.startswith("{") and raw.endswith("}\0"):
                return bytes(int(part, 16) for part in raw[1:-2].split(", "))
            raise SystemExit(f"unsupported acpi_call response: {raw!r}")

        def get_fan_curve():
            acpi_call(WMAB, [0, 0x05, bytes([0, 0, 0, 0])])
            data = acpi_read()
            if len(data) < 44:
                raise SystemExit(f"fan curve response too short: {len(data)} bytes")
            return [data[i] for i in range(4, 44, 4)]

        def set_fan_curve(curve):
            payload = bytes([
                0x00, 0x00, 0x0A, 0x00, 0x00, 0x00,
                curve[0], 0x00, curve[1], 0x00, curve[2], 0x00, curve[3], 0x00, curve[4], 0x00,
                curve[5], 0x00, curve[6], 0x00, curve[7], 0x00, curve[8], 0x00, curve[9], 0x00,
                0x00, 0x0A, 0x00, 0x00, 0x00,
                0x0A, 0x00, 0x14, 0x00, 0x1E, 0x00, 0x28, 0x00, 0x32, 0x00,
                0x3C, 0x00, 0x46, 0x00, 0x50, 0x00, 0x5A, 0x00, 0x64, 0x00, 0x00,
            ])
            acpi_call(WMAB, [0, 0x06, payload])

        def load_curve(path):
            with open(path) as f:
                config = json.load(f)
            points = config.get("pointsC", POINTS_C)
            if points != POINTS_C:
                raise SystemExit(f"pointsC must be {POINTS_C}")
            curve = config.get("speedsPercent")
            if not isinstance(curve, list) or len(curve) != 10:
                raise SystemExit("speedsPercent must contain exactly 10 integers")
            if any(not isinstance(value, int) for value in curve):
                raise SystemExit("speedsPercent must contain exactly 10 integers")
            if any(value < 0 or value > 115 for value in curve):
                raise SystemExit("speedsPercent values must be between 0 and 115")
            if config.get("enforceWindowsMinimums", True):
                for value, minimum in zip(curve, MIN_CURVE):
                    if value < minimum:
                        raise SystemExit(f"curve below windows minimums: {curve} < {MIN_CURVE}")
            return curve

        def print_curve(curve):
            print(json.dumps({"pointsC": POINTS_C, "speedsPercent": curve}, indent=2))

        match sys.argv[1:]:
            case ["status"]:
                print_curve(get_fan_curve())
            case ["validate", path]:
                print_curve(load_curve(path))
            case ["apply", path]:
                curve = load_curve(path)
                set_fan_curve(curve)
                print_curve(curve)
            case _:
                raise SystemExit("usage: legion-acpi status | validate <curve.json> | apply <curve.json>")
      ''} "$@"
    '';
  };
in {
  # Centralize privileged hardware writes used by the handheld shell.
  # Quickshell should trigger these through systemd/polkit instead of writing
  # sysfs or ACPI directly from the user session.

  boot.extraModulePackages = [ config.boot.kernelPackages.acpi_call ];
  boot.kernelModules = [ "acpi_call" ];

  environment.systemPackages = [ legionAcpi ];

  systemd.services.legion-fan-curve-apply = {
    description = "Apply Legion Go fan curve";
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${legionAcpi}/bin/legion-acpi apply ${fanCurveConfig}";
    };
  };

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
           action.lookup("unit").indexOf("ryzenadj-tdp@") == 0 ||
           action.lookup("unit") == "legion-fan-curve-apply.service") &&
          subject.user == "bdsqqq") {
        return polkit.Result.YES;
      }
    });
  '';
}
