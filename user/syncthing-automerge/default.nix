{ ... }:
{
  home-manager.users.bdsqqq =
    { pkgs, ... }:
    let
      script = pkgs.writeText "syncthing-automerge.ts" (builtins.readFile ./syncthing-automerge.ts);
    in
    {
      home.packages = [
        (pkgs.writeShellApplication {
          name = "syncthing-automerge";
          runtimeInputs = [
            pkgs.git
            pkgs.nodejs
          ];
          text = ''
            exec node ${script} "$@"
          '';
        })
      ];
    };
}
