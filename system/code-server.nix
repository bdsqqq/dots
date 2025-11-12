{ lib, pkgs, hostSystem ? null, ... }:
let
  isLinux = lib.hasInfix "linux" hostSystem;
  isDarwin = lib.hasInfix "darwin" hostSystem;
in
if isLinux then {
  services.code-server = {
    enable = true;
    user = "bdsqqq";
    host = "127.0.0.1";
    port = 8080;
    auth = "password";
  };
} else if isDarwin then {
  environment.systemPackages = [ pkgs.openvscode-server ];
  
  launchd.user.agents.openvscode-server = {
    serviceConfig = {
      Label = "com.bdsqqq.openvscode-server";
      ProgramArguments = [
        "${pkgs.openvscode-server}/bin/openvscode-server"
        "--host"
        "0.0.0.0"
        "--port"
        "8080"
        "--without-connection-token"
      ];
      RunAtLoad = true;
      KeepAlive = true;
      StandardOutPath = "/Users/bdsqqq/Library/Logs/openvscode-server.log";
      StandardErrorPath = "/Users/bdsqqq/Library/Logs/openvscode-server-error.log";
    };
  };
} else {}
