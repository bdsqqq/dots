{ lib, hostSystem ? null, ... }:

if !(lib.hasInfix "linux" hostSystem) then {} else {
  services.flatpak = {
    enable = true;
    uninstallUnmanaged = true;
    remotes = [
      { name = "flathub"; location = "https://dl.flathub.org/repo/flathub.flatpakrepo"; }
      { name = "flathub-beta"; location = "https://flathub.org/beta-repo/flathub-beta.flatpakrepo"; }
    ];
    packages = [
      "app.zen_browser.zen"
    ];
  };
}


