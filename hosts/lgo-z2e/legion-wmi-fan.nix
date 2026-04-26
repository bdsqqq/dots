{ config, pkgs, ... }:

let
  kernel = config.boot.kernelPackages.kernel;
  legionWmiFan = pkgs.stdenv.mkDerivation {
    pname = "lenovo-legion-wmi-fan";
    version = "0.1.0-60365f1";

    src = pkgs.fetchFromGitHub {
      owner = "honjow";
      repo = "lenovo-legion-go-wmi-fan";
      rev = "60365f1204aa97aaa0604c27197530c2474c90cd";
      hash = "sha256-MPLD+kbZSJT1tnU71QB1LJMofIoaY6LlXF2MpHku5Ck=";
    };

    nativeBuildInputs = kernel.moduleBuildDependencies;

    makeFlags = [
      "KERNELDIR=${kernel.dev}/lib/modules/${kernel.modDirVersion}/build"
      "KVER=${kernel.modDirVersion}"
    ];

    installPhase = ''
      runHook preInstall
      install -Dm444 lenovo-legion-wmi-fan.ko \
        $out/lib/modules/${kernel.modDirVersion}/extra/lenovo-legion-wmi-fan.ko
      runHook postInstall
    '';

    meta = {
      description = "hwmon fan curve driver for Lenovo Legion Go handhelds";
      homepage = "https://github.com/honjow/lenovo-legion-go-wmi-fan";
      license = pkgs.lib.licenses.mit;
      platforms = [ "x86_64-linux" ];
    };
  };
in {
  # why a kernel module instead of legion-acpi: WMAB method 0x05 returns a
  # binary ACPI buffer (`count + 10 speeds`) that /proc/acpi/call can truncate
  # when rendered as text. this module calls acpi_evaluate_object in kernel
  # space, then exposes normal hwmon files for quickshell and shell scripts.
  # source: honjow/lenovo-legion-go-wmi-fan README protocol notes.
  boot.extraModulePackages = [ legionWmiFan ];
  boot.kernelModules = [ "lenovo-legion-wmi-fan" ];

  environment.systemPackages = [ legionWmiFan ];
}
