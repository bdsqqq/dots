/* Pure Nix module for syncthing device and folder definitions.

   Design rationale:
   - Pure Nix (not NixOS module) to work in both system-level and home-manager contexts
   - Single source of truth for device IDs and addresses
   - Composable functions for building host-specific configs
   - Platform-aware folder paths (darwin vs linux)

   Usage:
     let syncthing = import ./modules/syncthing.nix;
     in {
       services.syncthing.settings.devices = syncthing.devicesFor [ "mbp-m2" "htz-relay" ];
     }
*/
{ lib }:

rec {
  /* All device definitions. `introducer` flag marks trusted devices that can
     introduce new devices to the mesh.
  */
  devices = {
    mbp-m2 = {
      id = "6QPGO5Z-ZBZZVDW-MCYFBKB-MGZQO47-GITV6C5-5YGBXLT-VWHNAQ4-5XMKDAG";
      addresses = [ "tcp://mbp-m2:22000" "quic://mbp-m2:22000" ];
      introducer = true;
    };
    lgo-z2e = {
      id = "4B7Q2Z5-SNAOQJO-S4L4FSG-IBBV5XH-67DUXTW-L3Z3JT7-CUQCWP6-TKHP5AG";
      addresses = [ "tcp://lgo-z2e:22000" "quic://lgo-z2e:22000" ];
    };
    htz-relay = {
      id = "HPMO7GH-P5UX4LC-OYSWWVP-XTMOUWL-QXUDAYH-ZJXXQDJ-QN677MY-QNQACQH";
      addresses = [ "tcp://htz-relay:22000" "quic://htz-relay:22000" ];
    };
    r56 = {
      id = "JOWDMTJ-LQKWV6K-5V37UTD-EKJBBHS-3FJPKWD-HRONTJC-F4NZGJN-VKJTZAQ";
      addresses = [ "tcp://r56:22000" "quic://r56:22000" ];
    };
    iph16 = {
      id = "L2PJ4F3-BZUZ4RX-3BCPIYB-V544M22-P3WDZBF-ZEVYT5A-GPTX5ZF-ZM5KTQK";
      addresses = [ "dynamic" ];
    };
    ipd = {
      id = "YORN2Q5-DWT444V-65WLF77-JHDHP5X-HHZEEFO-NKTLTYZ-M777AXS-X2KX6AF";
      addresses = [ "tcp://ipd:22000" "quic://ipd:22000" ];
    };
  };

  /* `devicesFor :: [String] -> AttrSet`
     Returns subset of devices for a host.
     Example: devicesFor [ "mbp-m2" "htz-relay" ] => { mbp-m2 = {...}; htz-relay = {...}; }
  */
  devicesFor = names:
    builtins.listToAttrs (builtins.map (name: {
      inherit name;
      value = devices.${name};
    }) names);

  /* `folderPaths :: String -> String -> Bool -> String`
     Returns the correct path for a folder given the folder name, home directory,
     and whether the host is darwin.

     Folder path mapping:
     - commonplace: `${home}/commonplace`
     - prism-instances: darwin: `${home}/Library/Application Support/PrismLauncher/instances`
                         linux: `${home}/.local/share/PrismLauncher/instances`
     - pi-sessions: `${home}/.pi/agent/sessions`
     - helium-remotes: `${home}/.local/share/helium-remotes`
  */
  folderPaths = name: home: isDarwin:
    let
      paths = {
        commonplace = "${home}/commonplace";
        prism-instances = if isDarwin then
          "${home}/Library/Application Support/PrismLauncher/instances"
        else
          "${home}/.local/share/PrismLauncher/instances";
        pi-sessions = "${home}/.pi/agent/sessions";
        helium-remotes = "${home}/.local/share/helium-remotes";
      };
    in paths.${name};

  # Folder ID mapping for syncthing internal use.
  folderIds = {
    commonplace = "sqz7z-a6tfg";
    prism-instances = "prism-instances";
    pi-sessions = "pi-sessions";
    helium-remotes = "helium-remotes";
  };

  /* `folderFor :: String -> String -> Bool -> [String] -> AttrSet -> AttrSet`
     Returns a full folder config.

     Parameters:
     - name: folder name (commonplace, prism-instances, pi-sessions, helium-remotes)
     - home: home directory path
     - isDarwin: whether the host is darwin
     - deviceNames: list of device names to share with
     - extraConfig: additional folder config to merge (optional, default {})

     Example:
       folderFor "commonplace" "/home/user" false [ "mbp-m2" "htz-relay" ] { type = "sendonly"; }
  */
  folderFor = name: home: isDarwin: deviceNames: extraConfig:
    let
      baseConfig = {
        enable = true;
        id = folderIds.${name};
        label = name;
        path = folderPaths name home isDarwin;
        type = "sendreceive";
        rescanIntervalS = 60;
        devices = deviceNames;
        versioning = {
          type = "trashcan";
          params.cleanoutDays = "0";
        };
      };
    in lib.recursiveUpdate baseConfig extraConfig;
}
