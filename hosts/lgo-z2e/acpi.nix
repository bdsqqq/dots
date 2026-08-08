{ config, pkgs, ... }:

let
  fanCurveConfig = "/home/bdsqqq/commonplace/01_files/nix/hosts/lgo-z2e/fan-curve.json";
  defaultTdpWatts = 12;
  tdpStateDir = "/var/lib/legion-power";
  applyTdp = pkgs.writeShellApplication {
    name = "apply-legion-tdp";
    runtimeInputs = [ pkgs.ryzenadj ];
    text = ''
      watts="$1"
      if [[ ! "$watts" =~ ^[0-9]+$ ]] || (( watts < 4 || watts > 30 )); then
        echo "TDP must be an integer between 4 and 30 watts" >&2
        exit 64
      fi

      # Lenovo's profile controls firmware thermal and fan policy; ryzenadj
      # then provides the exact package-power ceiling selected in Quickshell.
      printf '%s\n' balanced > /sys/firmware/acpi/platform_profile
      ryzenadj \
        --stapm-limit="$((watts * 1000))" \
        --fast-limit="$((watts * 1000))" \
        --slow-limit="$((watts * 1000))"
      printf '%s\n' "$watts" > ${tdpStateDir}/tdp-watts
    '';
  };
  restoreTdp = pkgs.writeShellApplication {
    name = "restore-legion-tdp";
    text = ''
      watts=${toString defaultTdpWatts}
      if [[ -r ${tdpStateDir}/tdp-watts ]]; then
        read -r watts < ${tdpStateDir}/tdp-watts
      fi
      if [[ ! "$watts" =~ ^[0-9]+$ ]] || (( watts < 4 || watts > 30 )); then
        watts=${toString defaultTdpWatts}
      fi
      exec ${applyTdp}/bin/apply-legion-tdp "$watts"
    '';
  };
  legionAcpiSource = pkgs.writeText "legion-acpi.ts" ''
    import { readFileSync, writeFileSync } from "node:fs";

    const ACPI_CALL = "/proc/acpi/call";
    const WMAB = String.raw`\_SB.GZFD.WMAB`;
    const POINTS_C = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const MIN_CURVE = [44, 48, 55, 60, 71, 79, 87, 87, 100, 100];
    const MAX_FIRMWARE_PERCENT = 115;

    function encodeArgument(argument: number | Uint8Array): string {
      if (typeof argument === "number") {
        return `0x''${argument.toString(16).padStart(2, "0")}`;
      }
      return `b''${Buffer.from(argument).toString("hex")}`;
    }

    function callAcpi(method: string, args: Array<number | Uint8Array>): void {
      writeFileSync(ACPI_CALL, [method, ...args.map(encodeArgument)].join(" "));
    }

    function parseAcpiBuffer(): Uint8Array {
      const raw = readFileSync(ACPI_CALL, "utf8").trim();
      if (raw === "not called\0") throw new Error("acpi_call returned: not called");
      if (!raw.startsWith("{")) {
        throw new Error(`unsupported acpi_call response: ''${JSON.stringify(raw)}`);
      }
      const body = raw.slice(1).replace(/\0+$/, "").replace(/}$/, "");
      return Uint8Array.from(
        body
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            const value = Number.parseInt(part, 16);
            if (!Number.isInteger(value)) {
              throw new Error(`invalid acpi byte: ''${part}`);
            }
            return value;
          }),
      );
    }

    function readFirmwareCurve(): number[] {
      callAcpi(WMAB, [0, 0x05, new Uint8Array(4)]);
      const data = parseAcpiBuffer();
      if (data.byteLength < 4) {
        throw new Error(`fan curve response too short: ''${data.byteLength} bytes`);
      }
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const count = view.getUint32(0, true);
      if (count < 1 || count > POINTS_C.length) {
        throw new Error(`invalid fan curve point count: ''${count}`);
      }
      const expected = 4 + count * 4;
      if (data.byteLength < expected) {
        throw new Error(
          `fan curve response too short: got ''${data.byteLength}, expected ''${expected}`,
        );
      }
      const speeds = Array.from(
        { length: count },
        (_, index) => view.getUint32(4 + index * 4, true),
      );
      while (speeds.length < POINTS_C.length) speeds.push(speeds.at(-1)!);
      return speeds;
    }

    function writeFirmwareCurve(speeds: number[]): void {
      const payload = new Uint8Array(52);
      const view = new DataView(payload.buffer);
      view.setUint32(2, POINTS_C.length, true);
      speeds.forEach((speed, index) => view.setUint16(6 + index * 2, speed, true));
      view.setUint32(27, POINTS_C.length, true);
      POINTS_C.forEach((temperature, index) =>
        view.setUint16(31 + index * 2, temperature, true),
      );
      callAcpi(WMAB, [0, 0x06, payload]);
    }

    function loadCurve(path: string): number[] {
      const config = JSON.parse(readFileSync(path, "utf8"));
      if (
        config.pointsC !== undefined &&
        JSON.stringify(config.pointsC) !== JSON.stringify(POINTS_C)
      ) {
        throw new Error(`pointsC must be fixed firmware points: ''${POINTS_C}`);
      }
      const speeds = config.speedsPercent;
      if (
        !Array.isArray(speeds) ||
        speeds.length !== POINTS_C.length ||
        speeds.some((value) => !Number.isInteger(value))
      ) {
        throw new Error(`speedsPercent must contain ''${POINTS_C.length} integers`);
      }
      if (speeds.some((value) => value < 0 || value > MAX_FIRMWARE_PERCENT)) {
        throw new Error(
          `speedsPercent values must be between 0 and ''${MAX_FIRMWARE_PERCENT}`,
        );
      }
      if (
        config.enforceWindowsMinimums !== false &&
        speeds.some((speed, index) => speed < MIN_CURVE[index])
      ) {
        throw new Error(`curve below windows minimums: ''${speeds} < ''${MIN_CURVE}`);
      }
      return speeds;
    }

    function output(speeds: number[]): void {
      console.log(JSON.stringify({ pointsC: POINTS_C, speedsPercent: speeds }, null, 2));
    }

    const [command, path] = Bun.argv.slice(2);
    if (command === "status") {
      output(readFirmwareCurve());
    } else if (command === "validate" && path) {
      output(loadCurve(path));
    } else if (command === "apply" && path) {
      const speeds = loadCurve(path);
      writeFirmwareCurve(speeds);
      output(speeds);
    } else {
      throw new Error(
        "usage: legion-acpi status | validate <curve.json> | apply <curve.json>",
      );
    }
  '';
  legionAcpi = pkgs.writeShellApplication {
    name = "legion-acpi";
    runtimeInputs = [ pkgs.bun ];
    text = ''
      exec bun ${legionAcpiSource} "$@"
    '';
  };
in
{
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

  # Successful changes persist across boots. Quickshell offers a conservative
  # 8–20 W envelope; deliberate shell use may choose any validated 4–30 W value.
  systemd.services."ryzenadj-tdp@" = {
    description = "Set CPU TDP to %i watts via ryzenadj";
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${applyTdp}/bin/apply-legion-tdp %i";
      StateDirectory = "legion-power";
    };
  };

  systemd.services.ryzenadj-tdp-restore = {
    description = "Restore the last selected CPU TDP";
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${restoreTdp}/bin/restore-legion-tdp";
      RemainAfterExit = true;
      StateDirectory = "legion-power";
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
