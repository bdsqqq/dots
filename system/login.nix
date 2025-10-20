{ lib, config, pkgs, ... }:

lib.mkIf pkgs.stdenv.isLinux {
  # Display manager
  services.greetd = {
    enable = true;
    settings.default_session = {
      command = "${pkgs.greetd.tuigreet}/bin/tuigreet --cmd Hyprland";
      user = "greeter";
    };
  };
}
