{
  config,
  headMode ? "graphical",
  lib,
  pkgs,
  ...
}:

let
  built = import ./package.nix { inherit lib pkgs; };
in
{
  options.my.mpv = {
    package = lib.mkOption {
      type = lib.types.package;
      default = built.package;
      readOnly = true;
      description = "Configured mpv package shared with dependent modules.";
    };
    transparentPackage = lib.mkOption {
      type = lib.types.package;
      default = built.transparentPackage;
      readOnly = true;
      description = "Standalone chroma-key mpv launcher package.";
    };
  };

  config = lib.mkIf (headMode == "graphical") {
    home-manager.users.bdsqqq.home.packages = with config.my.mpv; [
      package
      transparentPackage
    ];
  };
}
