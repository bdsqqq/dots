{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.fleetMesh;
  daemonPackage = pkgs.callPackage ./package.nix { };
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
  identityPaths = lib.mapAttrs (_: node: config.sops.secrets.${node.identitySecret}.path) cfg.nodes;
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
    stateDirectory = lib.mkOption {
      type = lib.types.str;
      default = "/Users/bdsqqq/Library/Application Support/fleet-mesh";
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
          == lib.sort builtins.lessThan (builtins.attrNames cfg.nodes);
        message = "my.fleetMesh roster ids must exactly match configured node ids";
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
    };

    my.tailnetRegistry.providers.fleet-mesh = {
      target = "http://127.0.0.1:${toString bridgePort}";
      scheme = "https";
      port = bridgePort;
      healthPath = "/health";
    };

    home-manager.users.bdsqqq = { config, lib, ... }: {
      home.packages = [ daemonPackage ];
      home.activation.fleetMeshState = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        mkdir -p ${lib.escapeShellArg cfg.stateDirectory}
        chmod 700 ${lib.escapeShellArg cfg.stateDirectory}
      '';
      launchd.agents = lib.mapAttrs' (
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
      ) cfg.nodes;
    };
  };
}
