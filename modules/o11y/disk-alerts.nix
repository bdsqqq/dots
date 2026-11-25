# each host declares how its disks are used; the fleet incident evaluator
# (./incidents) reads every host's declaration and pages accordingly. the
# thresholds live with the host because "low" means different things on a
# 37 GiB server root, a 460 GiB laptop, and a disk that exists to fill up.
{ lib, config, hostSystem ? null, ... }:
let
  GiB = 1024 * 1024 * 1024;
  cfg = config.my.diskAlerts;
  isDarwin = lib.hasInfix "darwin" hostSystem;
  # writable data mounts the collector reports; boot, APFS helper and bind
  # mounts are left out so one disk doesn't page twice.
  watchable = [ "/" "/mnt/storage-01" "/mnt/xfs-vdo" ];
  defaultMounts =
    if isDarwin then [ "/System/Volumes/Data" ]
    else builtins.filter (m: builtins.elem m watchable) (builtins.attrNames (config.fileSystems or { }));

  # `afterMinutes` is what tells a full disk apart from a busy one, so it's what
  # differs most between profiles. 0 opens on the first bad poll. `recover` sits
  # above `below` so the edge doesn't flap.
  level = defaults: lib.types.submodule {
    options = {
      below = lib.mkOption { type = lib.types.ints.positive; default = defaults.below; };
      recover = lib.mkOption { type = lib.types.ints.positive; default = defaults.recover; };
      afterMinutes = lib.mkOption { type = lib.types.ints.unsigned; default = defaults.afterMinutes; };
    };
  };
  levels = {
    # replayed against 14 days of per-minute samples (Nov 11–25): these keep
    # every real near-full event and drop the build/cache swings.
    server = {
      # a full root stops services and upgrades within minutes: page on the
      # first bad poll (afterMinutes = 0), as before.
      critical = { below = 2 * GiB; recover = 3 * GiB; afterMinutes = 0; };
      low = { below = 8 * GiB; recover = 10 * GiB; afterMinutes = 60; };
    };
    workstation = {
      # builds, caches and downloads move tens of GiB within the hour while
      # someone is at the keyboard: page only when it's about to break, or
      # when it has stayed low for half a day.
      critical = { below = 2 * GiB; recover = 3 * GiB; afterMinutes = 30; };
      low = { below = 8 * GiB; recover = 10 * GiB; afterMinutes = 720; };
    };
  };
  # for disks whose job is to fill up (backups, archives): the question is
  # "time to buy more?", so it's relative and slow, and never critical.
  capacity = lib.types.submodule {
    options = {
      belowFraction = lib.mkOption { type = lib.types.numbers.between 0.01 0.9; default = 0.15; };
      recoverFraction = lib.mkOption { type = lib.types.numbers.between 0.01 0.95; default = 0.2; };
      afterMinutes = lib.mkOption { type = lib.types.ints.unsigned; default = 360; };
    };
  };
  mount = lib.types.submodule {
    options = {
      critical = lib.mkOption { type = lib.types.nullOr (level levels.${cfg.profile}.critical); default = { }; };
      low = lib.mkOption { type = lib.types.nullOr (level levels.${cfg.profile}.low); default = { }; };
      capacity = lib.mkOption { type = lib.types.nullOr capacity; default = null; };
    };
  };
in
{
  options.my.diskAlerts = {
    profile = lib.mkOption {
      type = lib.types.enum (builtins.attrNames levels);
      default = if isDarwin then "workstation" else "server";
      description = "how this host is used; sets the default for every level below. set null on a level to turn it off for a mount.";
    };
    mounts = lib.mkOption {
      type = lib.types.attrsOf mount;
      description = "writable mountpoints the incident evaluator watches here, each with the profile's levels unless overridden.";
    };
    # the relay's evaluator reads this from every host's config, so it must stay plain data.
    resolved = lib.mkOption {
      type = lib.types.attrs;
      readOnly = true;
      internal = true;
    };
  };

  # defaults are a mkDefault'd set of empty entries, so a host that overrides one
  # mount keeps the others (attrsOf merges per key; a plain default would be replaced).
  config.my.diskAlerts.mounts = lib.mkMerge (map (m: { ${m} = lib.mkDefault { }; }) defaultMounts);
  config.my.diskAlerts.resolved = { inherit (cfg) profile; mounts = cfg.mounts; };

  config.assertions = lib.flatten (lib.mapAttrsToList (path: m:
    lib.optional (m.critical != null) {
      assertion = m.critical.recover > m.critical.below;
      message = "my.diskAlerts.mounts.\"${path}\".critical: recover must be above below, or the edge flaps";
    }
    ++ lib.optional (m.low != null) {
      assertion = m.low.recover > m.low.below;
      message = "my.diskAlerts.mounts.\"${path}\".low: recover must be above below, or the edge flaps";
    }
    ++ lib.optional (m.capacity != null) {
      assertion = m.capacity.recoverFraction > m.capacity.belowFraction;
      message = "my.diskAlerts.mounts.\"${path}\".capacity: recoverFraction must be above belowFraction";
    }) cfg.mounts);
}
