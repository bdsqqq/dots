{ config, lib, ... }:
let
  cfg = config.my.fleetMesh.credential;
in
{
  options.my.fleetMesh.credential.required =
    lib.mkEnableOption "the fleet mesh identity credentials";

  config = lib.mkIf cfg.required {
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
      "fleet-mesh/authority-private-key" = {
        sopsFile = ./secrets.yaml;
        key = "authority_private_key";
        owner = "bdsqqq";
        mode = "0400";
      };
    };
  };
}
