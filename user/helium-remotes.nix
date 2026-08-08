{ lib, pkgs, config, hostSystem ? null, headMode ? "graphical", ... }:

let
  cfg = config.my.heliumRemotes;
  isLinux = lib.hasInfix "linux" hostSystem;
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isGraphical = headMode == "graphical";
  port = 39221;
  syncedStateDir = ".local/share/helium-remotes";
  extensionDir = ".local/share/helium-remotes-extension";

  extension = pkgs.runCommand "helium-remotes-extension" { } ''
    mkdir -p $out
    cat > $out/manifest.json <<'JSON'
    {
      "manifest_version": 3,
      "name": "Helium Remotes",
      "version": "0.1.0",
      "description": "Publishes local Helium tabs for cross-host search.",
      "permissions": ["alarms", "tabs"],
      "host_permissions": ["http://127.0.0.1:${toString port}/*"],
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
    const endpoint = "http://127.0.0.1:${toString port}/tabs";
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
    const endpoint = "http://127.0.0.1:${toString port}/tabs";

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

  tabsSource = pkgs.writeText "helium-tabs.ts" ''
    import {
      mkdirSync,
      readdirSync,
      readFileSync,
      renameSync,
      writeFileSync,
    } from "node:fs";
    import { hostname } from "node:os";
    import { basename, join } from "node:path";

    function argument(name: string, fallback: string): string {
      const index = Bun.argv.indexOf(name);
      return index < 0 ? fallback : Bun.argv[index + 1];
    }

    function manifests(tabsDir: string): Record<string, unknown>[] {
      const result: Record<string, unknown>[] = [];
      for (const name of readdirSync(tabsDir).filter((name) => name.endsWith(".json")).sort()) {
        try {
          result.push(JSON.parse(readFileSync(join(tabsDir, name), "utf8")));
        } catch {}
      }
      return result;
    }

    const command = Bun.argv[2];
    const stateDir = argument(
      "--state-dir",
      join(process.env.HOME ?? "", "${syncedStateDir}"),
    );
    const tabsDir = join(stateDir, "tabs");
    mkdirSync(tabsDir, { recursive: true });

    if (command === "query") {
      const queryIndex = Bun.argv.findIndex(
        (value, index) => index > 2 && !value.startsWith("--") && Bun.argv[index - 1] !== "--state-dir",
      );
      const needle = (queryIndex < 0 ? "" : Bun.argv[queryIndex]).toLowerCase();
      for (const payload of manifests(tabsDir)) {
        const host = String(payload.host ?? "unknown");
        const tabs = Array.isArray(payload.tabs) ? payload.tabs : [];
        for (const rawTab of tabs) {
          if (!rawTab || typeof rawTab !== "object") continue;
          const tab = rawTab as Record<string, unknown>;
          const title = String(tab.title ?? "");
          const url = String(tab.url ?? "");
          if (needle && !`''${host} ''${title} ''${url}`.toLowerCase().includes(needle)) {
            continue;
          }
          console.log(`''${host}\t''${title}\t''${url}`);
        }
      }
    } else if (command === "agent") {
      const host = argument("--host", hostname());
      const bind = argument("--bind", "127.0.0.1");
      const port = Number(argument("--port", "${toString port}"));
      const output = join(tabsDir, `''${host}.json`);

      Bun.serve({
        hostname: bind,
        port,
        maxRequestBodySize: 1024 * 1024,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname !== "/tabs") {
            return new Response("not found\n", { status: 404 });
          }
          if (request.method === "GET") {
            return Response.json(
              { hosts: manifests(tabsDir) },
              { headers: { "access-control-allow-origin": "*" } },
            );
          }
          if (request.method !== "POST") {
            return new Response("method not allowed\n", { status: 405 });
          }
          const declared = Number(request.headers.get("content-length") ?? "0");
          if (declared > 1024 * 1024) {
            return new Response("payload too large\n", { status: 413 });
          }
          const payload = await request.json();
          if (!payload || typeof payload !== "object") {
            return new Response("invalid payload\n", { status: 400 });
          }
          const next = {
            ...(payload as Record<string, unknown>),
            host,
            schema: "helium-remotes.tabs.v1",
          };
          const temporary = join(tabsDir, `.''${basename(output)}.''${process.pid}.tmp`);
          writeFileSync(temporary, `''${JSON.stringify(next, null, 2)}\n`);
          renameSync(temporary, output);
          return new Response(null, { status: 204 });
        },
      });
    } else {
      throw new Error("usage: helium-tabs.ts query [text] | agent [options]");
    }
  '';

  tabsCli = pkgs.writeShellApplication {
    name = "helium-tabs";
    runtimeInputs = [ pkgs.bun ];
    text = ''
      exec bun ${tabsSource} query "$@"
    '';
  };

  tabsAgent = pkgs.writeShellApplication {
    name = "helium-tabs-agent";
    runtimeInputs = [ pkgs.bun ];
    text = ''
      exec bun ${tabsSource} agent "$@"
    '';
  };
in
{
  options.my.heliumRemotes = {
    enable = lib.mkEnableOption "Helium remote browser artifacts";
    tabsExtension.enable = lib.mkEnableOption "the Helium tabs publisher extension";
  };

  config = lib.mkIf (cfg.enable && (isLinux || isDarwin) && isGraphical) {
    home-manager.users.bdsqqq = { ... }: lib.mkMerge [
      {
        home.packages = [ tabsAgent tabsCli ];

        # keep the unpacked extension out of the synced tree. syncthing can
        # propagate nix-store symlink targets that only exist on one host.
        home.file."${extensionDir}".source = extension;
      }

      (lib.mkIf (cfg.tabsExtension.enable && isLinux) {
        systemd.user.services.helium-tabs-agent = {
          Unit.Description = "Helium tabs publisher sink";
          Service = {
            ExecStart = "${tabsAgent}/bin/helium-tabs-agent --state-dir %h/${syncedStateDir}";
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
              "/Users/bdsqqq/${syncedStateDir}"
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
