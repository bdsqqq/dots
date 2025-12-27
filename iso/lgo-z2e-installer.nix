{ config, pkgs, lib, modulesPath, inputs, ... }:

{
  imports = [
    (modulesPath + "/installer/cd-dvd/iso-image.nix")
    (modulesPath + "/profiles/all-hardware.nix")
    inputs.jovian-nixos.nixosModules.default
  ];

  config = {
    isoImage.isoBaseName = lib.mkForce "lgo-z2e-nixos-installer";
    isoImage.makeEfiBootable = true;
    isoImage.makeUsbBootable = true;
    isoImage.squashfsCompression = "zstd -Xcompression-level 10";
    isoImage.isoName = "${config.isoImage.isoBaseName}-${config.system.nixos.label}-${pkgs.stdenv.hostPlatform.system}.iso";

    hardware.enableRedistributableFirmware = true;
    hardware.enableAllFirmware = true;
    nixpkgs.config.allowUnfree = true;

    jovian = {
      steam.enable = true;
      hardware.has.amd.gpu = true;
    };

    services.handheld-daemon = {
      enable = true;
      user = "nixos";
      ui.enable = true;
    };

    services.openssh.enable = true;

    hardware.graphics = {
      enable = true;
      enable32Bit = true;
    };

    networking.networkmanager.enable = true;
    networking.wireless.enable = lib.mkForce false;

    users.users.nixos = {
      isNormalUser = true;
      extraGroups = [ "wheel" "networkmanager" "audio" "video" "input" ];
      initialPassword = "nixos";
    };

    security.sudo.wheelNeedsPassword = false;

    environment.systemPackages = with pkgs; [
      vim
      git
      htop
      parted
      gptfdisk
      dosfstools
      e2fsprogs
      networkmanager
      mangohud
    ];

    programs.zsh.enable = true;

    boot.kernelPackages = pkgs.linuxPackages_latest;
    boot.kernelParams = [ 
      "amd_pstate=active"
      "amdgpu.sg_display=0"
    ];

    system.stateVersion = "25.05";
  };
}
