{ lib, config, pkgs, hostSystem ? null, ... }:
let
  isLinux = hostSystem != null && lib.hasInfix "linux" hostSystem;
  isDarwin = hostSystem != null && lib.hasInfix "darwin" hostSystem;
in {
  services.tailscale = {
    enable = true;
  } // lib.optionalAttrs isLinux {
    extraUpFlags = lib.mkDefault [ "--ssh" ];
  };
} // lib.optionalAttrs isDarwin {
  launchd.daemons.tailscaled-autoconnect = lib.mkIf (config.sops.secrets ? tailscale_auth_key) {
    script = ''
      auth_key_file="${config.sops.secrets.tailscale_auth_key.path}"

      for _ in $(seq 1 30); do
        if [ ! -r "$auth_key_file" ]; then
          sleep 2
          continue
        fi

        state="$(${pkgs.tailscale}/bin/tailscale status --json --peers=false 2>/dev/null | ${pkgs.jq}/bin/jq -r '.BackendState // empty' 2>/dev/null || true)"
        case "$state" in
          Running)
            echo "tailscale already running"
            exit 0
            ;;
          NeedsLogin|NeedsMachineAuth)
            exec ${pkgs.tailscale}/bin/tailscale up \
              --auth-key "file:$auth_key_file" \
              --hostname "${config.networking.localHostName}"
            ;;
        esac

        sleep 2
      done

      echo "tailscale autoconnect skipped: daemon never reached an authable state"
    '';
    serviceConfig = {
      Label = "com.bdsqqq.tailscaled-autoconnect";
      RunAtLoad = true;
      StandardOutPath = "/var/log/tailscaled-autoconnect.log";
      StandardErrorPath = "/var/log/tailscaled-autoconnect.log";
    };
  };
}


