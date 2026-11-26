{
  config,
  lib,
  pkgs,
  hostSystem ? null,
  ...
}:

let
  cfg = config.my.kanata;
  source = "${config.my.paths.commonplace}/01_files/nix/modules/kanata";
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
  node = "${pkgs.nodejs_latest}/bin/node";
  kanataPackage = pkgs.kanata.overrideAttrs (old: {
    patches = (old.patches or [ ]) ++ [ ./log-date.patch ];
  });

  kanataLabel = "com.bdsqqq.kanata";
  virtualhidLabel = "com.bdsqqq.karabiner-virtualhid-daemon";
  virtualhidDaemon = "/Library/Application Support/org.pqrs/Karabiner-DriverKit-VirtualHIDDevice/Applications/Karabiner-VirtualHIDDevice-Daemon.app/Contents/MacOS/Karabiner-VirtualHIDDevice-Daemon";
  kanataStablePath = "/usr/local/bin/kanata";
  kanataStableLibDir = "/usr/local/lib/kanata";
  kanataConfig = "/etc/kanata/kanata.kbd";
  kanataArguments = [
    "--no-wait"
    "--cfg"
    kanataConfig
  ]
  ++ lib.optionals (cfg.tcpPort != null) [
    "--port"
    "127.0.0.1:${toString cfg.tcpPort}"
  ];

  controlConfig = {
    label = kanataLabel;
    plist = "/Library/LaunchDaemons/${kanataLabel}.plist";
    inherit virtualhidLabel virtualhidDaemon;
    virtualhidPlist = "/Library/LaunchDaemons/${virtualhidLabel}.plist";
    binary = kanataStablePath;
    config = kanataConfig;
    log = "/var/log/kanata.log";
    arguments = kanataArguments;
  };
  controlCommand = [
    node
    "--experimental-strip-types"
    "${source}/${if isDarwin then "control.ts" else "linux-control.ts"}"
  ]
  ++ lib.optional isDarwin (builtins.toJSON controlConfig);
  toggleKanata = pkgs.writeShellScriptBin "toggle-kanata" ''
    exec ${lib.escapeShellArgs controlCommand} "$@"
  '';
  testKanata = pkgs.writeShellScriptBin "kanata-test" ''
    exec ${
      lib.escapeShellArgs [
        "/usr/bin/sudo"
        "-n"
        node
        "--experimental-strip-types"
        "${source}/test-mode.ts"
        (builtins.toJSON controlConfig)
      ]
    } "$@"
  '';

  # Kanata 1.12 documents v6.2.0's IPC, not the latest DriverKit release.
  virtualhidPackage = pkgs.fetchurl {
    url = "https://github.com/pqrs-org/Karabiner-DriverKit-VirtualHIDDevice/raw/refs/tags/v6.2.0/dist/Karabiner-DriverKit-VirtualHIDDevice-6.2.0.pkg";
    hash = "sha256-noxGI58HSBYSQeQkRIV5ASJOXIL1tYoXMd9McL8HNqg=";
  };

  activationCommand = [
    "/bin/bash"
    "${source}/activate.sh"
    "${kanataPackage}/bin/kanata"
    "${pkgs.libiconv}/lib/libiconv.2.dylib"
    "${pkgs.libiconv}/lib/libcharset.1.dylib"
    kanataLabel
    virtualhidDaemon
    kanataStablePath
    kanataStableLibDir
  ];
  installCommand = [
    node
    "--experimental-strip-types"
    "${source}/install.ts"
    (builtins.toJSON {
      package = toString virtualhidPackage;
      version = "6.2.0";
      daemon = virtualhidDaemon;
      manager = "/Applications/.Karabiner-VirtualHIDDevice-Manager.app/Contents/MacOS/Karabiner-VirtualHIDDevice-Manager";
      stage = builtins.tail activationCommand;
    })
  ];
  installKanata = pkgs.writeShellScriptBin "kanata-install" ''
    exec ${lib.escapeShellArgs installCommand} "$@"
  '';
in
{
  options.my.kanata.tcpPort = lib.mkOption {
    type = lib.types.nullOr lib.types.port;
    default = null;
    description = ''
      Enable Kanata's unauthenticated loopback control server on this port.
      Only use this on a host where local processes are trusted.
    '';
  };

  config =
    if isDarwin then
      {
        environment.systemPackages = [
          toggleKanata
          testKanata
          installKanata
        ];
        environment.etc."kanata/kanata.kbd".source = ./kanata.kbd;
        system.activationScripts.extraActivation.text = lib.escapeShellArgs installCommand;

        launchd.daemons.karabiner-virtualhid-daemon.serviceConfig = {
          Label = virtualhidLabel;
          ProcessType = "Interactive";
          ProgramArguments = [ virtualhidDaemon ];
          RunAtLoad = true;
          KeepAlive = true;
          StandardOutPath = "/var/log/karabiner-virtualhid-daemon.log";
          StandardErrorPath = "/var/log/karabiner-virtualhid-daemon.log";
        };

        launchd.daemons.kanata.serviceConfig = {
          Label = kanataLabel;
          ProgramArguments = [ kanataStablePath ] ++ kanataArguments;
          RunAtLoad = true;
          KeepAlive = true;
          StandardOutPath = "/var/log/kanata.log";
          StandardErrorPath = "/var/log/kanata.log";
        };
      }
    else if isLinux then
      {
        environment.systemPackages = [
          pkgs.kanata
          toggleKanata
        ];
        environment.etc."kanata/kanata.kbd".source = ./kanata.kbd;
      }
    else
      { };
}
