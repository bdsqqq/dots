{ pkgs, lib, config, hostSystem ? null, ... }:

if !(lib.hasInfix "linux" hostSystem) then {} else {
  # Display manager with session selection
  # Only configure greetd if jovian is not handling autostart
  services.greetd = {
    enable = true;
    settings.default_session = lib.mkIf (!(config.jovian.steam.autoStart or false)) {
      # --sessions lists available .desktop files from /run/current-system/sw/share/wayland-sessions
      # --remember saves last session choice
      command = "${pkgs.tuigreet}/bin/tuigreet --sessions /run/current-system/sw/share/wayland-sessions --remember --remember-session";
      user = "greeter";
    };
  };
  
  # Ensure wayland session desktop files are available
  environment.pathsToLink = [ "/share/wayland-sessions" ];
}
