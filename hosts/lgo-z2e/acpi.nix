{ config, pkgs, ... }:

let
  fanCurveConfig = "/home/bdsqqq/commonplace/01_files/nix/hosts/lgo-z2e/fan-curve.json";
  legionAcpi = pkgs.writeShellApplication {
    name = "legion-acpi";
    runtimeInputs = [ pkgs.python3 ];
    text = ''
      exec python3 ${pkgs.writeText "legion-acpi.py" ''
        import json
        import struct
        import sys

        ACPI_CALL = "/proc/acpi/call"
        WMAB = r"\_SB.GZFD.WMAB"
        POINTS_C = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
        MIN_CURVE = [44, 48, 55, 60, 71, 79, 87, 87, 100, 100]
        MAX_FIRMWARE_PERCENT = 115

        def die(message):
            raise SystemExit(message)

        def encode_arg(arg):
            if isinstance(arg, int):
                return f"0x{arg:02x}"
            return f"b{arg.hex()}"

        def call_acpi(method, args):
            command = " ".join([method, *[encode_arg(arg) for arg in args]])
            try:
                with open(ACPI_CALL, "wb") as f:
                    f.write(command.encode())
            except PermissionError:
                die(f"permission denied writing {ACPI_CALL}; run as root or through systemd")

        def parse_acpi_buffer():
            try:
                with open(ACPI_CALL, "rb") as f:
                    raw = f.read().decode(errors="replace").strip()
            except PermissionError:
                die(f"permission denied reading {ACPI_CALL}; run as root or through systemd")

            if raw == "not called\0":
                die("acpi_call returned: not called")
            if not raw.startswith("{"):
                die(f"unsupported acpi_call response: {raw!r}")

            # /proc/acpi/call renders ACPI buffers as text. on this bios the
            # buffer may end with a nul byte before a closing brace is emitted,
            # so parse byte tokens instead of depending on exact punctuation.
            body = raw[1:].rstrip("\0")
            if body.endswith("}"):
                body = body[:-1]
            try:
                return bytes(int(part.strip(), 16) for part in body.split(",") if part.strip())
            except ValueError as error:
                die(f"invalid acpi buffer response: {raw!r}: {error}")

        def read_firmware_curve():
            call_acpi(WMAB, [0, 0x05, bytes(4)])
            data = parse_acpi_buffer()

            # legion go firmware returns: count(u32 le) + count speed values
            # (u32 le). hhd indexes the low byte of each u32; unpacking makes
            # the format explicit and matches the hwmon driver documentation.
            if len(data) < 4:
                die(f"fan curve response too short for count: {len(data)} bytes")
            count = struct.unpack_from("<I", data, 0)[0]
            if count < 1 or count > len(POINTS_C):
                die(f"invalid fan curve point count: {count}")
            expected_len = 4 + count * 4
            if len(data) < expected_len:
                die(f"fan curve response too short: got {len(data)} bytes, expected {expected_len}")

            speeds = [struct.unpack_from("<I", data, 4 + index * 4)[0] for index in range(count)]
            while len(speeds) < len(POINTS_C):
                speeds.append(speeds[-1])
            return speeds

        def write_firmware_curve(speeds):
            # WMAB method 0x06 takes 52 bytes:
            # padding(2), speed_count(u32 le), 10 speed values(u16 le),
            # padding(1), temp_count(u32 le), fixed temps(u16 le), padding(1).
            # temps are fixed by firmware; callers can only choose speeds.
            payload = bytearray(52)
            struct.pack_into("<I", payload, 2, len(POINTS_C))
            for index, speed in enumerate(speeds):
                struct.pack_into("<H", payload, 6 + index * 2, speed)
            struct.pack_into("<I", payload, 27, len(POINTS_C))
            for index, temp in enumerate(POINTS_C):
                struct.pack_into("<H", payload, 31 + index * 2, temp)

            call_acpi(WMAB, [0, 0x06, bytes(payload)])

        def load_curve(path):
            with open(path) as f:
                config = json.load(f)

            if config.get("pointsC", POINTS_C) != POINTS_C:
                die(f"pointsC must be fixed firmware points: {POINTS_C}")

            speeds = config.get("speedsPercent")
            if not isinstance(speeds, list) or len(speeds) != len(POINTS_C):
                die(f"speedsPercent must contain {len(POINTS_C)} integers")
            if any(not isinstance(value, int) for value in speeds):
                die("speedsPercent must contain integers only")
            if any(value < 0 or value > MAX_FIRMWARE_PERCENT for value in speeds):
                die(f"speedsPercent values must be between 0 and {MAX_FIRMWARE_PERCENT}")

            if config.get("enforceWindowsMinimums", True):
                for speed, minimum in zip(speeds, MIN_CURVE):
                    if speed < minimum:
                        die(f"curve below windows minimums: {speeds} < {MIN_CURVE}")
            return speeds

        def output(speeds):
            print(json.dumps({"pointsC": POINTS_C, "speedsPercent": speeds}, indent=2))

        match sys.argv[1:]:
            case ["status"]:
                output(read_firmware_curve())
            case ["validate", path]:
                output(load_curve(path))
            case ["apply", path]:
                speeds = load_curve(path)
                write_firmware_curve(speeds)
                output(speeds)
            case _:
                die("usage: legion-acpi status | validate <curve.json> | apply <curve.json>")
      ''} "$@"
    '';
  };
in {
  # centralize privileged hardware writes used by the handheld shell.
  # quickshell should trigger these through systemd/polkit instead of writing
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
