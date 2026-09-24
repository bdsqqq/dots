{ inputs, lib, ... }:
{
  home-manager.users.bdsqqq.imports = [ ./home.nix ];
  home-manager.users.bdsqqq.programs.ssh.settings = import ./fleet.nix {
    inherit lib;
    configurations = inputs.self.darwinConfigurations // inputs.self.nixosConfigurations;
  };
}
