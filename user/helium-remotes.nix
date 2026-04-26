{ lib, pkgs, config, hostSystem ? null, headMode ? "graphical", ... }:

let
  cfg = config.my.heliumRemotes;
  isLinux = lib.hasInfix "linux" hostSystem;
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isGraphical = headMode == "graphical";

  extension = pkgs.runCommand "helium-remotes-extension" { } ''
    mkdir -p $out
    cat > $out/manifest.json <<'JSON'
    {
      "manifest_version": 3,
      "name": "Helium Remotes",
      "version": "0.1.0",
      "description": "Publishes local Helium tabs for cross-host search.",
      "permissions": ["alarms", "tabs"],
      "host_permissions": ["http://127.0.0.1:39221/*"],
      "background": { "service_worker": "background.js" }
    }
    JSON
    cat > $out/background.js <<'JS'
    const endpoint = "http://127.0.0.1:39221/tabs";

    async function publishTabs() {
      const tabs = await chrome.tabs.query({});
      await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capturedAt: new Date().toISOString(),
          tabs: tabs.map((tab) => ({
            id: tab.id,
            windowId: tab.windowId,
            index: tab.index,
            active: tab.active,
            pinned: tab.pinned,
            audible: tab.audible,
            title: tab.title,
            url: tab.url,
            favIconUrl: tab.favIconUrl
          }))
        })
      }).catch(() => {});
    }

    chrome.runtime.onInstalled.addListener(() => {
      chrome.alarms.create("publish-tabs", { periodInMinutes: 1 });
      publishTabs();
    });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === "publish-tabs") publishTabs();
    });
    chrome.tabs.onCreated.addListener(publishTabs);
    chrome.tabs.onUpdated.addListener(publishTabs);
    chrome.tabs.onRemoved.addListener(publishTabs);
    chrome.tabs.onActivated.addListener(publishTabs);
    JS
  '';

  tabsCli = pkgs.writeShellApplication {
    name = "helium-tabs";
    runtimeInputs = [ pkgs.python3 ];
    text = ''
      set -euo pipefail
      exec ${pkgs.python3}/bin/python3 - "$@" <<'PY'
      import argparse, glob, json, os

      parser = argparse.ArgumentParser()
      parser.add_argument("query", nargs="?", default="")
      parser.add_argument("--state-dir", default=os.path.expanduser("~/.local/share/helium-remotes"))
      args = parser.parse_args()

      needle = args.query.lower()
      for path in sorted(glob.glob(os.path.join(args.state_dir, "tabs", "*.json"))):
          with open(path) as f:
              payload = json.load(f)
          host = payload.get("host", os.path.basename(path).removesuffix(".json"))
          for tab in payload.get("tabs", []):
              title = tab.get("title") or ""
              url = tab.get("url") or ""
              haystack = f"{host} {title} {url}".lower()
              if needle and needle not in haystack:
                  continue
              print(f"{host}\t{title}\t{url}")
      PY
    '';
  };

  tabsAgent = pkgs.writeShellApplication {
    name = "helium-tabs-agent";
    runtimeInputs = [ pkgs.python3 pkgs.coreutils ];
    text = ''
      set -euo pipefail
      exec ${pkgs.python3}/bin/python3 - "$@" <<'PY'
      import argparse, json, os, socket, tempfile
      from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

      parser = argparse.ArgumentParser()
      parser.add_argument("--state-dir", default=os.path.expanduser("~/.local/share/helium-remotes"))
      parser.add_argument("--host", default=socket.gethostname())
      parser.add_argument("--bind", default="127.0.0.1")
      parser.add_argument("--port", type=int, default=39221)
      args = parser.parse_args()

      tabs_dir = os.path.join(args.state_dir, "tabs")
      os.makedirs(tabs_dir, exist_ok=True)
      output = os.path.join(tabs_dir, f"{args.host}.json")

      class Handler(BaseHTTPRequestHandler):
          def do_POST(self):
              if self.path != "/tabs":
                  self.send_error(404)
                  return
              length = int(self.headers.get("content-length", "0"))
              payload = json.loads(self.rfile.read(length) or b"{}")
              payload["host"] = args.host
              payload["schema"] = "helium-remotes.tabs.v1"
              fd, tmp = tempfile.mkstemp(prefix=f".{args.host}.", suffix=".json", dir=tabs_dir)
              with os.fdopen(fd, "w") as f:
                  json.dump(payload, f, indent=2, sort_keys=True)
                  f.write("\n")
              os.replace(tmp, output)
              self.send_response(204)
              self.end_headers()

          def log_message(self, format, *args):
              return

      ThreadingHTTPServer((args.bind, args.port), Handler).serve_forever()
      PY
    '';
  };
in {
  options.my.heliumRemotes = {
    enable = lib.mkEnableOption "Helium remote browser artifacts";
    tabsExtension.enable = lib.mkEnableOption "the Helium tabs publisher extension";
  };

  config = lib.mkIf (cfg.enable && (isLinux || isDarwin) && isGraphical) {
    home-manager.users.bdsqqq = { ... }: lib.mkMerge [
      {
        home.packages = [ tabsAgent tabsCli ];
        home.file.".local/share/helium-remotes/extension".source = extension;
      }

      (lib.mkIf (cfg.tabsExtension.enable && isLinux) {
        systemd.user.services.helium-tabs-agent = {
          Unit.Description = "Helium tabs publisher sink";
          Service = {
            ExecStart = "${tabsAgent}/bin/helium-tabs-agent --state-dir %h/.local/share/helium-remotes";
            Restart = "on-failure";
          };
          Install.WantedBy = [ "default.target" ];
        };
      })

      (lib.mkIf (cfg.tabsExtension.enable && isDarwin) {
        launchd.agents.helium-tabs-agent = {
          enable = true;
          config = {
            ProgramArguments = [
              "${tabsAgent}/bin/helium-tabs-agent"
              "--state-dir"
              "/Users/bdsqqq/.local/share/helium-remotes"
            ];
            RunAtLoad = true;
            KeepAlive = true;
            StandardOutPath = "/Users/bdsqqq/Library/Logs/helium-tabs-agent.log";
            StandardErrorPath = "/Users/bdsqqq/Library/Logs/helium-tabs-agent.log";
          };
        };
      })
    ];
  };
}
