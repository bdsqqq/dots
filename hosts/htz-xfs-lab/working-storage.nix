{
  config,
  lib,
  pkgs,
  ...
}:
let
  storage = builtins.fromJSON (builtins.readFile ./storage.json);
  inherit (storage) volume home directories;
  mounts = map (directory: "${home}/${directory}") directories;
  # admission cannot load its code from the volume it is responsible for gating.
  tool = pkgs.writeShellApplication {
    name = "working-storage";
    runtimeInputs = [
      pkgs.nodejs_latest
      pkgs.util-linux
      pkgs.vdo
      pkgs.lvm2_vdo
      config.nix.package
    ];
    text = ''
      exec node ${./working-storage.ts} --config ${./storage.json} "$@"
    '';
  };
  cli = "${tool}/bin/working-storage";
in
{
  # preserve native editable paths, rather than the older /repos checkouts.
  fileSystems = lib.listToAttrs (
    map (directory: {
      name = "${home}/${directory}";
      value = {
        device = "${volume}/host-data/bdsqqq/${directory}";
        fsType = "none";
        depends = [ volume ];
        options = [
          "bind"
          "nofail"
          "x-systemd.requires=working-storage-sources.service"
        ];
      };
    }) directories
  );

  nix.settings = {
    build-dir = "${volume}/nix-build";
    min-free = 4 * 1024 * 1024 * 1024;
    max-free = 8 * 1024 * 1024 * 1024;
  };

  # systemd creates absent bind sources; admission must precede every mount job.
  systemd.services.working-storage-sources = {
    description = "Validate seeded working-storage sources before bind mounts";
    unitConfig.RequiresMountsFor = [ volume ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${cli} sources";
    };
  };
  systemd.services.working-storage-prepare = {
    description = "Prepare scratch directories on the working volume";
    unitConfig.RequiresMountsFor = [ volume ] ++ mounts;
    before = [
      "nix-daemon.service"
      "nixos-upgrade.service"
    ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${cli} prepare";
    };
  };
  systemd.services.nix-daemon = {
    requires = [ "working-storage-prepare.service" ];
    after = [ "working-storage-prepare.service" ];
    unitConfig.RequiresMountsFor = [ volume ];
    serviceConfig.ExecStartPre = [ "${cli} ready --volume-only" ];
  };
  systemd.services.nixos-upgrade = {
    unitConfig.RequiresMountsFor = mounts;
    serviceConfig.ExecStartPre = [ "${cli} ready" ];
  };

  home-manager.users.bdsqqq = {
    home.sessionVariables.TMPDIR = "${home}/.cache/tmp";
    home.file.".config/systemd/user/t3code.service.d/storage.conf".text = ''
      [Service]
      ExecStartPre=${cli} ready
      Environment=TMPDIR=${home}/.cache/tmp
    '';
  };

  # min-free runs during builds; this also covers pressure between builds.
  systemd.services.working-storage-gc = {
    description = "Recover root headroom when below 4 GiB";
    serviceConfig = {
      Type = "oneshot";
      Nice = 10;
      IOSchedulingClass = "idle";
      ExecStart = "${cli} gc";
    };
  };
  systemd.timers.working-storage-gc = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "5min";
      OnUnitActiveSec = "5min";
    };
  };

  # failed/missing physical statistics remain visible as systemd failures.
  environment.systemPackages = [ tool ];
  systemd.services.working-storage-health = {
    description = "Check root headroom and VDO physical capacity";
    after = [ "working-storage-gc.service" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${cli} health";
    };
  };
  systemd.timers.working-storage-health = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "6min";
      OnUnitActiveSec = "5min";
    };
  };
}
