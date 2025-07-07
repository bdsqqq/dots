{ config, pkgs, lib, ... }:

{
  services.flatpak = {
    enable = true;
    
    # Manage all flatpak packages and repositories declaratively
    uninstallUnmanaged = true;
    
    # Remote repositories
    remotes = [
      {
        name = "flathub";
        location = "https://dl.flathub.org/repo/flathub.flatpakrepo";
      }
      {
        name = "flathub-beta";
        location = "https://flathub.org/beta-repo/flathub-beta.flatpakrepo";
      }
    ];
    
    # Packages to install
    packages = [
      "app.zen_browser.zen"
    ];
  };
}