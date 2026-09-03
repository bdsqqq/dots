{ lib
, python3
, writeShellApplication
,
}:

writeShellApplication {
  name = "fleet-esp32-pool";
  runtimeInputs = [ python3 ];
  text = ''
    exec python3 ${./esp32_pool.py} "$@"
  '';
  meta = {
    description = "Supervisor for isolated ESP32-S3 QEMU fleet guests";
    license = lib.licenses.mit;
    mainProgram = "fleet-esp32-pool";
    platforms = [ "aarch64-darwin" ];
  };
}
