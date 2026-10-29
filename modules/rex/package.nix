{ pkgs, bootstrap }:
let
  source = pkgs.lib.fileset.toSource {
    root = ./.;
    fileset = pkgs.lib.fileset.unions [ ./update.ts ./release.ts ];
  };
in
{
  # native installs and systemd must use the same writable executable.
  runtime = pkgs.runCommand "rex-live-install" {
    meta.mainProgram = "rex";
  } ''
    mkdir -p "$out/bin" "$out/share"
    ln -s /usr/local/bin/rex "$out/bin/rex"
    ln -s ${bootstrap}/share/terminfo "$out/share/terminfo"
    ln -s ${bootstrap}/share/rex "$out/share/rex"
  '';

  updater = pkgs.writeShellApplication {
    name = "rex-update";
    runtimeInputs = [ pkgs.nodejs_24 pkgs.curl pkgs.gnutar pkgs.gzip ]
      ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.util-linux ];
    text = ''
      if [[ "''${1:-}" == "--help" ]]; then
        exec node ${source}/update.ts --help
      fi
      exec flock /run/lock/rex-update.lock node ${source}/update.ts "$@"
    '';
  };
}
