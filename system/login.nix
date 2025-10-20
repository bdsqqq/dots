{ lib, hostSystem ? null, ... }:

if !(lib.hasInfix "linux" hostSystem) then {} else {
  # Display manager
  services.greetd = {
    enable = true;
    settings.default_session = {
      command = "${pkgs.greetd.tuigreet}/bin/tuigreet --cmd Hyprland";
      user = "greeter";
    };
  };
}
