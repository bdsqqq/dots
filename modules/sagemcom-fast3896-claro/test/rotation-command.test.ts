import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { supportedDevice } from "../src/device.generated.ts";
import type { WireRequest } from "../src/protocol.ts";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/rotate-bike-iot.ts", import.meta.url));
const newPassword = "fixture-new-password";
const adminPassword = "fixture-admin-password";
const keyPath = "Device/WiFi/AccessPoints/AccessPoint[Alias='GUEST1']/Security/KeyPassphrase";

type Mode =
  | "normal"
  | "wrong-ssid"
  | "disabled"
  | "wrong-firmware"
  | "denied"
  | "dropped-write"
  | "readback-mismatch"
  | "dropped-logout";

async function fixture(
  mode: Mode,
  run: (context: {
    invoke: (args?: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
    writes: WireRequest["request"]["actions"];
    state: { key: string };
  }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "bike-iot-rotation-"));
  const adminFile = join(dir, "admin-password");
  const newFile = join(dir, "new-password");
  writeFileSync(adminFile, adminPassword + "\n", { mode: 0o600 });
  writeFileSync(newFile, newPassword + "\n", { mode: 0o600 });
  const writes: WireRequest["request"]["actions"] = [];
  const state = { key: "fixture-old-password" };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const wire: WireRequest = JSON.parse(
      new URLSearchParams(Buffer.concat(chunks).toString()).get("req")!,
    );
    const request = wire.request;
    const actions = request.actions.map((action) => {
      const ok = { code: 16777238, description: "fixture" };
      let parameters: Record<string, unknown> = {};
      if (action.method === "logIn") parameters = { id: 1, nonce: "fixture-nonce" };
      if (action.method === "getValue") {
        let value: unknown;
        if (action.xpath === "Device/DeviceInfo") {
          value = {
            DeviceInfo: {
              Manufacturer: supportedDevice.manufacturer,
              ModelName: supportedDevice.model,
              ProductClass: supportedDevice.productClass,
              HardwareVersion: supportedDevice.hardwareVersion,
              SoftwareVersion:
                mode === "wrong-firmware"
                  ? "unsupported-firmware"
                  : supportedDevice.softwareVersion,
              GUIAPIVersion: supportedDevice.guiApiVersion,
            },
          };
        } else if (action.xpath === keyPath)
          value = mode === "readback-mismatch" ? "fixture-different-password" : state.key;
        else if (action.xpath?.endsWith("/SSID"))
          value = mode === "wrong-ssid" ? "Other" : "Bike-IoT";
        else if (action.xpath?.endsWith("/Enable")) value = mode !== "disabled";
        parameters = { value };
      }
      if (action.method === "setValue") {
        writes.push(action);
        if (mode === "denied")
          return { id: action.id, error: { code: 16777245, description: "denied" } };
        state.key = String(action.parameters?.value);
      }
      return { id: action.id, error: ok, callbacks: [{ result: ok, parameters }] };
    });
    if (
      (mode === "dropped-write" && writes.length) ||
      (mode === "dropped-logout" && request.actions[0]?.method === "logOut")
    ) {
      req.socket.destroy();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        reply: { id: request.id, error: { code: 16777216, description: "fixture" }, actions },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run({
      writes,
      state,
      invoke: async (args = []) => {
        const env = {
          ...process.env,
          FAST3896_CLARO_URL: `http://127.0.0.1:${address.port}`,
          FAST3896_CLARO_USERNAME: "fixture-user",
          FAST3896_CLARO_PASSWORD_FILE: adminFile,
          FAST3896_CLARO_NEW_PASSWORD_FILE: newFile,
        };
        let result;
        try {
          const output = await exec(process.execPath, [script, ...args], { env, timeout: 10_000 });
          result = { code: 0, ...output };
        } catch (error) {
          const failed = error as { code: number; stdout: string; stderr: string };
          result = { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
        }
        assert.doesNotMatch(
          result.stdout + result.stderr,
          new RegExp(`${newPassword}|${adminPassword}|fixture-old-password`),
        );
        return result;
      },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

test("rotation command is read-only by default", async () => {
  await fixture("normal", async ({ invoke, writes, state }) => {
    const result = await invoke();
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { status: "ready" });
    assert.equal(writes.length, 0);
    assert.equal(state.key, "fixture-old-password");
  });
});

for (const mode of ["wrong-ssid", "disabled", "wrong-firmware"] as const) {
  test(`preflight stops for ${mode}`, async () => {
    await fixture(mode, async ({ invoke, writes }) => {
      assert.equal((await invoke()).code, 1);
      assert.equal(writes.length, 0);
    });
  });
}

test("explicit apply invokes the SDK's single-key rotation and confirms readback", async () => {
  await fixture("normal", async ({ invoke, writes, state }) => {
    const result = await invoke(["--apply"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { status: "verified" });
    assert.deepEqual(writes, [
      { id: 0, method: "setValue", xpath: keyPath, parameters: { value: newPassword } },
    ]);
    assert.equal(state.key, newPassword);
  });
});

for (const mode of ["wrong-ssid", "wrong-firmware", "denied", "readback-mismatch"] as const) {
  test(`apply fails without announcing success for ${mode}`, async () => {
    await fixture(mode, async ({ invoke, writes }) => {
      const result = await invoke(["--apply"]);
      assert.equal(result.code, 1);
      assert.doesNotMatch(result.stdout, /"verified"/);
      assert.equal(writes.length, mode === "wrong-ssid" || mode === "wrong-firmware" ? 0 : 1);
    });
  });
}

test("a lost response reports unknown outcome and never retries an applied write", async () => {
  await fixture("dropped-write", async ({ invoke, writes, state }) => {
    const result = await invoke(["--apply"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /"outcome":"unknown"/);
    assert.equal(writes.length, 1);
    assert.equal(state.key, newPassword);
  });
});

test("logout failure does not misreport an already verified password change", async () => {
  await fixture("dropped-logout", async ({ invoke, writes }) => {
    const result = await invoke(["--apply"]);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), { status: "verified" });
    assert.match(result.stderr, /session logout failed/);
    assert.equal(writes.length, 1);
  });
});

test("help and unknown arguments never write or echo a password argument", async () => {
  await fixture("normal", async ({ invoke, writes }) => {
    assert.equal((await invoke(["--help"])).code, 0);
    const bad = await invoke(["--password", "fixture-unwanted-argument"]);
    assert.equal(bad.code, 1);
    assert.doesNotMatch(bad.stdout + bad.stderr, /fixture-unwanted-argument/);
    assert.equal(writes.length, 0);
  });
});
