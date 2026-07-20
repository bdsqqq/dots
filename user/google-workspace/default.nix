{ inputs, lib, ... }:
let
  skillsDir = "${inputs.google-workspace-cli}/skills";
  skills = lib.filterAttrs (_: type: type == "directory") (builtins.readDir skillsDir);
  skillFiles = lib.mapAttrs' (name: _:
    lib.nameValuePair ".config/agents/skills/${name}" {
      source = "${skillsDir}/${name}";
      recursive = true;
    }) skills;
in
{
  home-manager.users.bdsqqq = { pkgs, ... }: {
    home.packages = [
      inputs.google-workspace-cli.packages.${pkgs.stdenv.hostPlatform.system}.gws
      # Python 3.14's libffi aborts during gcloud startup on Apple Silicon.
      (pkgs.google-cloud-sdk.override { python314 = pkgs.python313; })
    ];

    home.file = skillFiles;
  };
}
