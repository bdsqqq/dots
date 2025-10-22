{ lib, pkgs, hostSystem ? null, ... }:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
in
if isDarwin then {
  # Darwin implementation with launchd
  environment.systemPackages = [ pkgs.kanata
    (pkgs.writeShellScriptBin "kanata-test" ''
      echo "SAFE Kanata Test Mode"
      echo "This will start kanata for 60 seconds, then automatically stop"
      echo "If your keyboard breaks, just wait 60 seconds and it will recover"
      echo "Press Enter to start 60-second test"
      read
      
      echo "Starting VirtualHIDDevice daemon..."
      sudo "/Library/Application Support/org.pqrs/Karabiner-DriverKit-VirtualHIDDevice/Applications/Karabiner-VirtualHIDDevice-Daemon.app/Contents/MacOS/Karabiner-VirtualHIDDevice-Daemon" &
      DAEMON_PID=$!
      sleep 2
      
      echo "Starting kanata for 60 seconds..."
      sudo ${pkgs.kanata}/bin/kanata --cfg /etc/kanata/kanata.kbd &
      KANATA_PID=$!
      
      echo "TEST YOUR KEYBOARD NOW - you have 60 seconds"
      echo "Try your homerow mods: A=Shift, S=Ctrl, D=Alt, F=Cmd"
      echo "Counting down..."
      for i in {60..1}; do
        if [ $((i % 10)) -eq 0 ]; then
          echo "$i seconds remaining"
        fi
        sleep 1
      done
      
      echo "Stopping kanata and daemon..."
      sudo kill $KANATA_PID 2>/dev/null || true
      sudo kill $DAEMON_PID 2>/dev/null || true
      sudo killall kanata 2>/dev/null || true
      sudo killall Karabiner-VirtualHIDDevice-Daemon 2>/dev/null || true
      
      echo "Test complete. Did your keyboard work correctly? (y/n)"
      read response
      if [[ "$response" =~ ^[Yy]$ ]]; then
        echo "Great! You can now use 'kanata-start' to run permanently"
      else
        echo "Something went wrong. Check the logs and configuration."
      fi
    '')
    (pkgs.writeShellScriptBin "kanata-start" ''
      echo "Starting kanata permanently..."
      sudo "/Library/Application Support/org.pqrs/Karabiner-DriverKit-VirtualHIDDevice/Applications/Karabiner-VirtualHIDDevice-Daemon.app/Contents/MacOS/Karabiner-VirtualHIDDevice-Daemon" &
      sleep 2
      sudo ${pkgs.kanata}/bin/kanata --cfg /etc/kanata/kanata.kbd &
      echo "Kanata is now running. Use 'kanata-stop' to stop it."
    '')
    (pkgs.writeShellScriptBin "kanata-stop" ''
      echo "Stopping kanata and VirtualHIDDevice daemon..."
      sudo killall kanata 2>/dev/null || true
      sudo killall Karabiner-VirtualHIDDevice-Daemon 2>/dev/null || true
      echo "Stopped."
    '')
  ];
  
  environment.etc."kanata/kanata.kbd".source = ../assets/kanata.kbd;
  
  system.activationScripts.extraActivation.text = ''
    if [ ! -d "/Applications/.Karabiner-VirtualHIDDevice-Manager.app" ]; then
      echo "Installing Karabiner-DriverKit-VirtualHIDDevice..."
      /usr/bin/curl -L https://github.com/pqrs-org/Karabiner-DriverKit-VirtualHIDDevice/releases/download/v6.0.0/Karabiner-DriverKit-VirtualHIDDevice-6.0.0.pkg -o /tmp/karabiner-virtualhid.pkg
      /usr/sbin/installer -pkg /tmp/karabiner-virtualhid.pkg -target /
      /bin/rm -f /tmp/karabiner-virtualhid.pkg
      echo "Activating VirtualHIDDevice..."
      /Applications/.Karabiner-VirtualHIDDevice-Manager.app/Contents/MacOS/Karabiner-VirtualHIDDevice-Manager activate
    fi
  '';
  
  launchd.daemons.karabiner-virtualhid-daemon = {
    serviceConfig = {
      Label = "com.bdsqqq.karabiner-virtualhid-daemon";
      ProgramArguments = [
        "/Library/Application Support/org.pqrs/Karabiner-DriverKit-VirtualHIDDevice/Applications/Karabiner-VirtualHIDDevice-Daemon.app/Contents/MacOS/Karabiner-VirtualHIDDevice-Daemon"
      ];
      RunAtLoad = true;
      KeepAlive = true;
      StandardOutPath = "/var/log/karabiner-virtualhid-daemon.log";
      StandardErrorPath = "/var/log/karabiner-virtualhid-daemon.log";
    };
  };

  launchd.daemons.kanata = {
    serviceConfig = {
      Label = "com.bdsqqq.kanata";
      ProgramArguments = [
        "/bin/bash"
        "-c"
        "sleep 5 && ${pkgs.kanata}/bin/kanata --cfg /etc/kanata/kanata.kbd"
      ];
      RunAtLoad = true;
      KeepAlive = true;
      StandardOutPath = "/var/log/kanata.log";
      StandardErrorPath = "/var/log/kanata.log";
    };
  };
} else if isLinux then {
  # Linux implementation (services.kanata provided by host config)
  environment.systemPackages = [ pkgs.kanata ];
  environment.etc."kanata/kanata.kbd".source = ../assets/kanata.kbd;
} else {}
