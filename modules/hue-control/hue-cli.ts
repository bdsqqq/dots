import { pathToFileURL } from "node:url";

type Request = (input: string, init?: RequestInit) => Promise<Response>;

const defaultUrl = "https://hue.tail1543a7.ts.net";

function usage(): never {
  throw new Error(
    "usage: hue [--url URL] <state|commission|reconnect|on|off|brightness VALUE|temperature VALUE|color X Y>",
  );
}

function number(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!value || !Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

export async function runHueCli(
  input: readonly string[],
  request: Request = fetch,
): Promise<unknown> {
  const args = [...input];
  let origin = process.env.HUE_CONTROL_URL ?? defaultUrl;
  if (args[0] === "--url") {
    origin = args[1] ?? usage();
    args.splice(0, 2);
  }
  origin = origin.replace(/\/$/, "");

  const command = args.shift() ?? usage();
  let path: string;
  let body: unknown;
  switch (command) {
    case "state":
      path = "/api/state";
      break;
    case "commission":
    case "reconnect":
      path = `/api/${command}`;
      body = {};
      break;
    case "on":
    case "off":
      path = "/api/light";
      body = { power: command === "on" };
      break;
    case "brightness":
      path = "/api/light";
      body = { brightness: number(args.shift(), "brightness") };
      break;
    case "temperature":
      path = "/api/light";
      body = { colorTemperature: number(args.shift(), "temperature") };
      break;
    case "color":
      path = "/api/light";
      body = { colorXy: [number(args.shift(), "x"), number(args.shift(), "y")] };
      break;
    default:
      usage();
  }
  if (args.length > 0) usage();

  const response = await request(`${origin}${path}`, {
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof result === "object" && result !== null && "message" in result
        ? String(result.message)
        : `request failed with ${response.status}`;
    throw new Error(message);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await runHueCli(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
