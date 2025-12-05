{ pkgs, lib, hostSystem ? null, ... }:

if !(lib.hasInfix "linux" hostSystem) then {} else {
  # Display manager with session selection
  services.greetd = {
    enable = true;
    settings.default_session = {
      # --sessions lists available .desktop files from /run/current-system/sw/share/wayland-sessions
      # --remember saves last session choice
      command = "${pkgs.greetd.tuigreet}/bin/tuigreet --sessions /run/current-system/sw/share/wayland-sessions --remember --remember-session";
      user = "greeter";
    };
  };
  
  # Ensure wayland session desktop files are available
  environment.pathsToLink = [ "/share/wayland-sessions" ];
}
