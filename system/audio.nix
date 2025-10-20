{ lib, hostSystem ? null, ... }:

if !(lib.hasInfix "linux" hostSystem) then {} else {
  # Audio with PipeWire
  services.pipewire = {
    enable = true;
    alsa.enable = true;
    alsa.support32Bit = true;
    pulse.enable = true;
    jack.enable = true;
    
    # WirePlumber configuration for default HDMI audio
    wireplumber = {
      enable = true;
      configPackages = [
        (pkgs.writeTextDir "share/wireplumber/wireplumber.conf.d/51-hdmi-default.conf" ''
          monitor.alsa.rules = [
            {
              matches = [
                {
                  device.name = "~alsa_card.pci-0000_*_00.1"
                }
              ]
              actions = {
                update-props = {
                  api.alsa.use-acp = true
                  device.profile.switch = true
                  device.profile = "output:hdmi-stereo"
                }
              }
            }
          ]
        '')
      ];
    };
  };
  
  # Security
  security.rtkit.enable = true;
}
