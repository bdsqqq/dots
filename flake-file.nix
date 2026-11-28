# transitional: platform inputs plus feature inputs not yet moved beside their
# module. a feature owns its inputs in modules/<feature>/flake-file.nix.
# `nix run .#write-flake` regenerates flake.nix from every flake-file.nix.
{
  flake-file.description = "Multi-system nix configuration with enhanced foundation";

  flake-file.inputs = {
    flake-file.url = "github:denful/flake-file";

    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";

    flake-parts.url = "github:hercules-ci/flake-parts";

    nix-darwin.url = "github:nix-darwin/nix-darwin/master";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";

    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";

    sops-nix.url = "github:Mic92/sops-nix";
    sops-nix.inputs.nixpkgs.follows = "nixpkgs";

    disko.url = "github:nix-community/disko";
    disko.inputs.nixpkgs.follows = "nixpkgs";

    berkeley-mono.url = "path:./modules/fonts/berkeley-mono";
    berkeley-mono.flake = false;

    stylix = {
      url = "github:danth/stylix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    nix-flatpak.url = "github:gmodena/nix-flatpak";

    # Vicinae launcher (no nixpkgs.follows to preserve cachix cache hits)
    vicinae.url = "github:vicinaehq/vicinae/main";

    axiom-deploy-annotation.url = "github:bdsqqq/axiom-deploy-annotation";
    axiom-deploy-annotation.inputs.nixpkgs.follows = "nixpkgs";

    niri.url = "github:sodiboo/niri-flake";
    niri.inputs.niri-unstable.follows = "niri-unstable";
    # niri-flake builds this as its compositor source, so it is not a flake
    niri-unstable = {
      url = "github:niri-wm/niri/v26.04";
      flake = false;
    };

    quickshell = {
      url = "git+https://git.outfoxxed.me/outfoxxed/quickshell";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # Jovian NixOS - Steam Deck experience for handhelds
    jovian-nixos = {
      url = "github:Jovian-Experiments/Jovian-NixOS";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    copyparty = {
      url = "github:9001/copyparty";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    lnr = {
      url = "github:bdsqqq/lnr";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    rex = {
      url = "https://pkgs.superlogical.com/rex/nix/snapshot.tar.gz";
      inputs.nixpkgs.follows = "nixpkgs";
    };

  };
}
