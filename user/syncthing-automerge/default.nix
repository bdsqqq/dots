{ lib, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  homeDir = if isDarwin then "/Users/bdsqqq" else "/home/bdsqqq";
  scriptDir = "${homeDir}/commonplace/01_files/nix/user/syncthing-automerge";
in {
  home-manager.users.bdsqqq = { pkgs, lib, ... }: {
    # install deps declaratively
    home.activation.installSyncthingAutomergeDeps =
      lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        if [ -f "${scriptDir}/package.json" ]; then
          "${pkgs.bun}/bin/bun" install --cwd "${scriptDir}" --frozen-lockfile 2>/dev/null \
            || "${pkgs.bun}/bin/bun" install --cwd "${scriptDir}" || true
        fi
      '';

    home.packages = [
      (pkgs.writeScriptBin "syncthing-automerge"
        (builtins.readFile ./syncthing-automerge.ts))
    ];
  };
}
