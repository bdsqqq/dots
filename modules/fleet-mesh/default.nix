{ config
, inputs
, lib
, pkgs
, ...
}:
let
  cfg = config.my.fleetMesh;
  daemonPackage = pkgs.callPackage ./package.nix { };
  poolPackage = pkgs.callPackage ./esp32-pool.nix { };
  espIdf = inputs.esp-dev.packages.${pkgs.stdenv.hostPlatform.system}.esp-idf-xtensa;
  qemu = inputs.qemu-espressif.packages.${pkgs.stdenv.hostPlatform.system}.qemu-esp32;
  firmwarePackage = pkgs.callPackage ./esp32-firmware.nix { inherit espIdf; };
  publicIdentityType = lib.types.submodule {
    options = {
      id = lib.mkOption { type = lib.types.str; };
      signingPublicKey = lib.mkOption { type = lib.types.str; };
      encryptionPublicKey = lib.mkOption { type = lib.types.str; };
    };
  };
  peerType = lib.types.submodule {
    options = {
      id = lib.mkOption { type = lib.types.str; };
      url = lib.mkOption { type = lib.types.str; };
    };
  };
  nodeType = lib.types.submodule {
    options = {
      port = lib.mkOption { type = lib.types.port; };
      identitySecret = lib.mkOption {
        type = lib.types.str;
        description = "sops secret containing this node's sole private identity";
      };
      peers = lib.mkOption { type = lib.types.listOf peerType; };
    };
  };
  simulatedNodeType = lib.types.submodule {
    options = {
      port = lib.mkOption { type = lib.types.port; };
      identitySecret = lib.mkOption {
        type = lib.types.str;
        description = "sops secret containing this guest's sole private identity";
      };
      peers = lib.mkOption { type = lib.types.listOf peerType; };
    };
  };
  publicConfiguration =
    id: node:
    pkgs.writeText "fleet-mesh-${id}.json" (
      builtins.toJSON {
        version = 1;
        fleet = cfg.fleet;
        inherit (cfg) authority roster;
        node = {
          inherit id;
          hostname = "127.0.0.1";
          inherit (node) port;
          statePath = "${cfg.stateDirectory}/${id}.json";
        };
        inherit (node) peers;
        inherit (cfg) contactIntervalMs contactTimeoutMs;
      }
    );
  bridgePort =
    if builtins.hasAttr cfg.bridgeNodeId cfg.nodes then cfg.nodes.${cfg.bridgeNodeId}.port else 1;
  allNodes = cfg.nodes // cfg.simulatedNodes;
  identityPaths = lib.mapAttrs (_: node: config.sops.secrets.${node.identitySecret}.path) allNodes;
  guestPublicConfiguration =
    node:
    pkgs.writeText "fleet-mesh-esp32-${node.id}.json" (
      builtins.toJSON {
        version = 1;
        inherit (cfg) fleet authority roster contactIntervalMs contactTimeoutMs;
        inherit (node) peers;
      }
    );
  poolConfiguration = pkgs.writeText "fleet-mesh-esp32-pool.json" (builtins.toJSON {
    version = 1;
    firmwareImage = "${firmwarePackage}/flash_image.bin";
    qemu = "${qemu}/bin/qemu-system-xtensa";
    stateDirectory = cfg.simulatedStateDirectory;
    configOffset = 2424832;
    configSize = 65536;
    devices = lib.mapAttrsToList
      (
        id: node: {
          inherit id;
          hostPort = node.port;
          publicConfigurationPath = guestPublicConfiguration (node // { inherit id; });
          identityPath = identityPaths.${id};
        }
      )
      cfg.simulatedNodes;
  });
in
{
  options.my.fleetMesh = {
    enable = lib.mkEnableOption "three-node fleet mesh deployment on mmn";
    fleet = lib.mkOption {
      type = lib.types.str;
      default = "home";
    };
    bridgeNodeId = lib.mkOption {
      type = lib.types.str;
      default = "mmn-m4";
    };
    authority = {
      id = lib.mkOption { type = lib.types.str; };
      publicKey = lib.mkOption { type = lib.types.str; };
    };
    roster = lib.mkOption {
      type = lib.types.listOf publicIdentityType;
    };
    nodes = lib.mkOption {
      type = lib.types.attrsOf nodeType;
    };
    simulatedNodes = lib.mkOption {
      type = lib.types.attrsOf simulatedNodeType;
      default = { };
    };
    stateDirectory = lib.mkOption {
      type = lib.types.str;
      default = "/Users/bdsqqq/Library/Application Support/fleet-mesh";
    };
    simulatedStateDirectory = lib.mkOption {
      type = lib.types.str;
      default = "/Users/bdsqqq/Library/Application Support/fleet-mesh/esp32-pool";
    };
    contactIntervalMs = lib.mkOption {
      type = lib.types.ints.positive;
      default = 2000;
    };
    contactTimeoutMs = lib.mkOption {
      type = lib.types.ints.positive;
      default = 1000;
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = builtins.hasAttr cfg.bridgeNodeId cfg.nodes;
        message = "my.fleetMesh.bridgeNodeId must name a configured node";
      }
      {
        assertion = builtins.length (builtins.attrNames cfg.nodes) == 3;
        message = "the mmn fleet deployment requires exactly three logical nodes";
      }
      {
        assertion =
          lib.sort builtins.lessThan (map (entry: entry.id) cfg.roster)
          == lib.sort builtins.lessThan (builtins.attrNames allNodes);
        message = "my.fleetMesh roster ids must exactly match daemon and simulated node ids";
      }
      {
        assertion = builtins.length (builtins.attrNames cfg.simulatedNodes) == 3;
        message = "the mmn ESP32 QEMU pool requires exactly three simulated nodes";
      }
    ];

    sops.secrets = {
      "fleet-mesh/bridge-identity" = {
        sopsFile = ./secrets.yaml;
        key = "mmn_m4_identity";
        owner = "bdsqqq";
        mode = "0400";
      };
      "fleet-mesh/relay-identity" = {
        sopsFile = ./secrets.yaml;
        key = "relay_identity";
        owner = "bdsqqq";
        mode = "0400";
      };
      "fleet-mesh/virtual-esp32-identity" = {
        sopsFile = ./secrets.yaml;
        key = "virtual_esp32_identity";
        owner = "bdsqqq";
        mode = "0400";
      };
      "fleet-mesh/esp32-sim-1-identity" = {
        sopsFile = ./secrets.yaml;
        key = "esp32_sim_1_identity";
        owner = "bdsqqq";
        mode = "0400";
      };
      "fleet-mesh/esp32-sim-2-identity" = {
        sopsFile = ./secrets.yaml;
        key = "esp32_sim_2_identity";
        owner = "bdsqqq";
        mode = "0400";
      };
      "fleet-mesh/esp32-sim-3-identity" = {
        sopsFile = ./secrets.yaml;
        key = "esp32_sim_3_identity";
        owner = "bdsqqq";
        mode = "0400";
      };
    };

    my.tailnetRegistry.providers.fleet-mesh = {
      target = "http://127.0.0.1:${toString bridgePort}";
      scheme = "https";
      port = bridgePort;
      healthPath = "/health";
    };

    home-manager.users.bdsqqq = { config, lib, ... }: {
      home.packages = [
        daemonPackage
        poolPackage
      ];
      home.activation.fleetMeshState = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        mkdir -p ${lib.escapeShellArg cfg.stateDirectory}
        chmod 700 ${lib.escapeShellArg cfg.stateDirectory}
        mkdir -p ${lib.escapeShellArg cfg.simulatedStateDirectory}
        chmod 700 ${lib.escapeShellArg cfg.simulatedStateDirectory}
      '';
      launchd.agents =
        lib.mapAttrs'
          (
            id: node:
              lib.nameValuePair "fleet-mesh-${id}" {
                enable = true;
                config = {
                  ProgramArguments = [
                    "${daemonPackage}/bin/fleet-daemon"
                    "--config"
                    "${publicConfiguration id node}"
                    "--identity"
                    identityPaths.${id}
                  ];
                  RunAtLoad = true;
                  KeepAlive = true;
                  ThrottleInterval = 10;
                  ProcessType = "Background";
                  StandardOutPath = "${config.home.homeDirectory}/Library/Logs/fleet-mesh-${id}.log";
                  StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/fleet-mesh-${id}.log";
                };
              }
          )
          cfg.nodes
        // {
          fleet-mesh-esp32-pool = {
            enable = true;
            config = {
              ProgramArguments = [
                "${poolPackage}/bin/fleet-esp32-pool"
                "--config"
                "${poolConfiguration}"
              ];
              RunAtLoad = true;
              KeepAlive = true;
              ThrottleInterval = 10;
              ProcessType = "Background";
              StandardOutPath = "${config.home.homeDirectory}/Library/Logs/fleet-mesh-esp32-pool.log";
              StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/fleet-mesh-esp32-pool.log";
            };
          };
        };
    };
  };
}
