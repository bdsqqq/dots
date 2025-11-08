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
  environment.systemPackages = [ pkgs.code-server ];
  
  launchd.user.agents.code-server = {
    serviceConfig = {
      Label = "com.bdsqqq.code-server";
      ProgramArguments = [
        "${pkgs.code-server}/bin/code-server"
        "--bind-addr"
        "127.0.0.1:8080"
        "--auth"
        "password"
      ];
      RunAtLoad = true;
      KeepAlive = true;
      StandardOutPath = "/Users/bdsqqq/Library/Logs/code-server.log";
      StandardErrorPath = "/Users/bdsqqq/Library/Logs/code-server-error.log";
    };
  };
} else {}
