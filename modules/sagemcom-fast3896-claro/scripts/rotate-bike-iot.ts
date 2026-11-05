import { readFileSync } from "node:fs";
import { SagemcomFast3896Claro, TransportError, XmoError } from "../src/index.ts";

const expectedSsid = "Bike-IoT";

function secretFile(variable: string): string {
  const path = process.env[variable];
  if (!path) throw new Error("missing secret file");
  return readFileSync(path, "utf8").replace(/\r?\n$/, "");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "pnpm run bike-iot:rotate [--apply] (default: read-only preflight; see RUNBOOK.md)",
    );
    return;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== "--apply")) {
    throw new Error("unsupported arguments; use --help");
  }

  const apply = args[0] === "--apply";
  const password = apply ? secretFile("FAST3896_CLARO_NEW_PASSWORD_FILE") : undefined;
  const router = new SagemcomFast3896Claro({
    baseUrl: process.env.FAST3896_CLARO_URL ?? "http://192.168.0.1",
    auth: {
      mode: "credentials",
      username: process.env.FAST3896_CLARO_USERNAME ?? "",
      password: secretFile("FAST3896_CLARO_PASSWORD_FILE"),
    },
    allowMutations: apply,
  });

  try {
    await router.assertCompatible();
    if (password === undefined) {
      const network = await router.wifi.guest.get();
      const ready = network.ssid === expectedSsid && network.enabled;
      console.log(JSON.stringify({ status: ready ? "ready" : "not-ready" }));
      process.exitCode = ready ? 0 : 1;
      return;
    }

    const result = await router.wifi.guest.rotatePassword({ expectedSsid, password });
    // Never serialize the native reply: it can contain credentials unrelated to this summary.
    console.log(JSON.stringify({ status: result.status }));
    process.exitCode = result.status === "verified" ? 0 : 1;
  } finally {
    try {
      await router.logout();
    } catch {
      // A failed session cleanup does not undo a verified password change.
      console.error(
        "warning: session logout failed; do not repeat rotation just to close the session",
      );
    }
  }
}

try {
  await main();
} catch (error) {
  const outcome =
    error instanceof TransportError && error.outcome === "unknown" ? "unknown" : "not-verified";
  console.error(
    JSON.stringify({
      status: "failed",
      outcome,
      ...(error instanceof XmoError ? { code: error.code } : {}),
    }),
  );
  process.exitCode = 1;
}
