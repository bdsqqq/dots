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
      "background": { "service_worker": "background.js" },
      "action": { "default_popup": "popup.html" }
    }
    JSON
    cat > $out/popup.html <<'HTML'
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          :root { color-scheme: dark; }
          body {
            width: 420px;
            margin: 0;
            font: 13px system-ui, sans-serif;
            background: #111;
            color: #eee;
          }
          header {
            position: sticky;
            top: 0;
            padding: 10px;
            background: #181818;
            border-bottom: 1px solid #333;
          }
          input {
            box-sizing: border-box;
            width: 100%;
            padding: 7px 9px;
            border: 1px solid #444;
            border-radius: 6px;
            background: #0b0b0b;
            color: #eee;
          }
          h2 {
            margin: 12px 10px 6px;
            font-size: 12px;
            font-weight: 700;
            color: #aaa;
            text-transform: uppercase;
            letter-spacing: .04em;
          }
          button {
            display: block;
            width: 100%;
            padding: 8px 10px;
            border: 0;
            border-top: 1px solid #222;
            background: transparent;
            color: inherit;
            text-align: left;
            cursor: pointer;
          }
          button:hover { background: #242424; }
          .title {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .url {
            margin-top: 2px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: #8a8a8a;
            font-size: 12px;
          }
          .empty { padding: 16px 10px; color: #999; }
        </style>
      </head>
      <body>
        <header><input id="filter" placeholder="search remote tabs" autofocus /></header>
        <main id="tabs"><div class="empty">loading…</div></main>
        <script src="popup.js"></script>
      </body>
    </html>
    HTML
    cat > $out/popup.js <<'JS'
    const endpoint = "http://127.0.0.1:39221/tabs";
    const filter = document.getElementById("filter");
    const container = document.getElementById("tabs");
    let manifests = [];

    function render() {
      const query = filter.value.trim().toLowerCase();
      container.textContent = "";
      let count = 0;

      for (const manifest of manifests) {
        const tabs = (manifest.tabs || []).filter((tab) => {
          const haystack = `''${manifest.host || ""} ''${tab.title || ""} ''${tab.url || ""}`.toLowerCase();
          return !query || haystack.includes(query);
        });
        if (!tabs.length) continue;

        const heading = document.createElement("h2");
        heading.textContent = manifest.host || "unknown host";
        container.appendChild(heading);

        for (const tab of tabs) {
          const button = document.createElement("button");
          const title = document.createElement("div");
          const url = document.createElement("div");
          title.className = "title";
          url.className = "url";
          title.textContent = tab.title || tab.url || "untitled";
          url.textContent = tab.url || "";
          button.append(title, url);
          button.addEventListener("click", () => {
            if (tab.url) chrome.tabs.create({ url: tab.url });
          });
          container.appendChild(button);
          count += 1;
        }
      }

      if (!count) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = query ? "no matching tabs" : "no remote tabs yet";
        container.appendChild(empty);
      }
    }

    fetch(endpoint)
      .then((response) => response.json())
      .then((payload) => {
        manifests = payload.hosts || [];
        render();
      })
      .catch(() => {
        container.innerHTML = '<div class="empty">helium-tabs-agent is not reachable</div>';
      });

    filter.addEventListener("input", render);
    JS
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
      import argparse, glob, json, os, socket, tempfile
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
          def do_GET(self):
              if self.path != "/tabs":
                  self.send_error(404)
                  return
              hosts = []
              for path in sorted(glob.glob(os.path.join(tabs_dir, "*.json"))):
                  with open(path) as f:
                      hosts.append(json.load(f))
              body = json.dumps({"hosts": hosts}, sort_keys=True).encode()
              self.send_response(200)
              self.send_header("content-type", "application/json")
              self.send_header("content-length", str(len(body)))
              self.end_headers()
              self.wfile.write(body)

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
        home.file.".local/share/helium-remotes-extension".source = extension;
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
