# git's own external inputs. `nix run .#write-flake` folds this into flake.nix.
{
  flake-file.inputs.hunk = {
    url = "github:modem-dev/hunk";
    inputs.nixpkgs.follows = "nixpkgs";
  };
}
