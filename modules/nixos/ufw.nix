# ufw configuration for tailscale access
{ config, pkgs, lib, ... }:

{
  # Install ufw
  environment.systemPackages = with pkgs; [ ufw ];
  
  # Create systemd service to configure ufw on boot
  systemd.services.ufw-tailscale-setup = {
    description = "Configure UFW for Tailscale";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];
    
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    
    script = ''
      # enable ufw
      ${pkgs.ufw}/bin/ufw --force enable
      
      # allow ssh
      ${pkgs.ufw}/bin/ufw allow 22
      
      # allow all traffic on tailscale interface
      ${pkgs.ufw}/bin/ufw allow in on tailscale0
      ${pkgs.ufw}/bin/ufw allow out on tailscale0
      
      # allow syncthing ports
      ${pkgs.ufw}/bin/ufw allow 22000
      ${pkgs.ufw}/bin/ufw allow 21027/udp
      ${pkgs.ufw}/bin/ufw allow 8384
    '';
  };
}