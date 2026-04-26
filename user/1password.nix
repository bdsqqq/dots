{ lib, hostSystem ? null, headMode ? "graphical", ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
in lib.mkIf (headMode == "graphical") (lib.mkMerge [
  (if isLinux then {
    programs._1password.enable = true;
    programs._1password-gui = {
      enable = true;
      polkitPolicyOwners = [ "bdsqqq" ];
    };
  } else
    { })

  (if isDarwin then {
    homebrew.casks = [
      "1password"
      "1password-cli"
    ];
  } else
    { })
])
