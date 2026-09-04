export const hueControlHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#101114">
  <title>Hue control</title>
  <style>
    :root { color-scheme: dark; font: 16px/1.4 system-ui, sans-serif; background: #101114; color: #f4f4f2; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: max(20px, env(safe-area-inset-top)) 20px max(20px, env(safe-area-inset-bottom)); }
    main { width: min(100%, 420px); }
    header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
    h1 { font-size: 1.25rem; margin: 0; }
    #status { color: #a9aaa7; font-size: .875rem; }
    #status::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-right: 7px; border-radius: 50%; background: #d45b55; }
    #status.available::before { background: #72c384; }
    section { background: #1a1c20; border: 1px solid #292c31; border-radius: 20px; padding: 20px; box-shadow: 0 18px 60px #0006; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 18px 0; }
    label { color: #c9cac6; }
    input[type=range] { width: 62%; accent-color: #f2d27a; }
    input[type=color] { width: 64px; height: 44px; padding: 0; border: 0; border-radius: 12px; background: transparent; }
    button { appearance: none; border: 0; border-radius: 14px; padding: 13px 17px; color: #101114; background: #f2d27a; font: inherit; font-weight: 650; }
    button.secondary { color: #f4f4f2; background: #30333a; }
    button:disabled, input:disabled { opacity: .45; }
    #power { width: 100%; font-size: 1.05rem; margin-bottom: 6px; }
    #setup { display: none; }
    #candidate { overflow-wrap: anywhere; color: #a9aaa7; font-size: .85rem; }
    #error { min-height: 1.4em; color: #ef8d86; font-size: .875rem; margin: 16px 2px 0; }
  </style>
</head>
<body>
<main>
  <header><h1>nearby light</h1><span id="status">loading</span></header>
  <section id="controls">
    <button id="power" disabled>turn on</button>
    <div class="row"><label for="brightness">brightness</label><input id="brightness" type="range" min="1" max="254" disabled></div>
    <div class="row"><label for="temperature">warmth</label><input id="temperature" type="range" min="153" max="500" disabled></div>
    <div class="row"><label for="color">color</label><input id="color" type="color" value="#ffffff" disabled></div>
    <button id="reconnect" class="secondary">reconnect</button>
  </section>
  <section id="setup">
    <p>make the bulb discoverable in Hue, then approve the macOS Bluetooth prompts.</p>
    <button id="commission">commission bulb</button>
  </section>
  <p id="error"></p>
</main>
<script type="module">
  const q = (id) => document.getElementById(id);
  let state;
  let pendingCommand;
  let sendingCommand = false;

  async function request(path, options) {
    const response = await fetch(path, options);
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || body.error || response.statusText);
    return body;
  }

  function xyFromHex(hex) {
    const linear = (value) => value > .04045 ? ((value + .055) / 1.055) ** 2.4 : value / 12.92;
    const r = linear(parseInt(hex.slice(1, 3), 16) / 255);
    const g = linear(parseInt(hex.slice(3, 5), 16) / 255);
    const b = linear(parseInt(hex.slice(5, 7), 16) / 255);
    const x = r * .664511 + g * .154324 + b * .162028;
    const y = r * .283881 + g * .668433 + b * .047685;
    const z = r * .000088 + g * .07231 + b * .986039;
    const total = x + y + z;
    return total === 0 ? [0, 0] : [x / total, y / total];
  }

  async function command(value) {
    pendingCommand = value;
    if (sendingCommand) return;
    sendingCommand = true;
    q("error").textContent = "";
    try {
      while (pendingCommand) {
        const nextCommand = pendingCommand;
        pendingCommand = undefined;
        await request("/api/light", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(nextCommand),
        });
      }
      await refresh();
    } catch (error) {
      pendingCommand = undefined;
      q("error").textContent = error.message;
    } finally {
      sendingCommand = false;
    }
  }

  async function refresh() {
    try {
      state = await request("/api/state");
      const available = state.status === "available";
      q("status").textContent = state.status;
      q("status").className = state.status;
      q("controls").style.display = state.status === "unenrolled" ? "none" : "block";
      q("setup").style.display = state.status === "unenrolled" ? "block" : "none";
      for (const id of ["power", "brightness", "temperature", "color"]) q(id).disabled = !available;
      if (state.light) {
        q("power").textContent = state.light.power ? "turn off" : "turn on";
        q("brightness").value = state.light.brightness;
        q("temperature").value = state.light.colorTemperature;
      }
      q("error").textContent = state.lastError || "";
    } catch (error) { q("error").textContent = error.message; }
  }

  q("power").onclick = () => command({ power: !state.light.power });
  q("brightness").onchange = (event) => command({ brightness: Number(event.target.value) });
  q("temperature").onchange = (event) => command({ colorTemperature: Number(event.target.value) });
  q("color").onchange = (event) => command({ colorXy: xyFromHex(event.target.value) });
  q("reconnect").onclick = async () => { await request("/api/reconnect", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); await refresh(); };
  q("commission").onclick = async () => {
    q("error").textContent = "commissioning… approve Bluetooth on the host if prompted";
    try {
      await request("/api/commission", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      await refresh();
    } catch (error) { q("error").textContent = error.message; }
  };
  await refresh();
  setInterval(refresh, 3000);
</script>
</body>
</html>`;
