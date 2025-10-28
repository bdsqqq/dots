{ lib, ... }:
{
  home-manager.users.bdsqqq = { config, lib, ... }: {
    # central PATH ordering system
    # modules contribute segments with priority; lower order = earlier in PATH
    options.custom.path.segments = lib.mkOption {
      type = lib.types.listOf (lib.types.submodule {
        options = {
          order = lib.mkOption {
            type = lib.types.int;
            description = "priority (lower = earlier in PATH)";
          };
          value = lib.mkOption {
            type = lib.types.str;
            description = "path to add";
          };
        };
      });
      default = [];
      description = "ordered PATH segments from all modules";
    };

    # aggregate all segments into home.sessionPath
    config.home.sessionPath = 
      let
        sorted = builtins.sort (a: b: a.order < b.order) config.custom.path.segments;
        paths = map (x: x.value) sorted;
      in
        lib.unique paths;
  };
}
