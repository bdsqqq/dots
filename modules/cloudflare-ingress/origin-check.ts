import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createEventLogger, safeErrorCode } from "../service-events/events.ts";

const execute = promisify(execFile);

type Run = (file: string, args: string[]) => Promise<{ stdout: string }>;

/** Probe metadata never includes the origin URL, response body, or curl's exception text. */
export async function checkOrigin(
  app: string,
  origin: string,
  curl: string,
  options: { run?: Run; events?: ReturnType<typeof createEventLogger> } = {},
): Promise<boolean> {
  const events = options.events ?? createEventLogger("cloudflare-ingress");
  const operation = events.begin("origin.check", "probe", { action: app, method: "GET" });
  const run: Run = options.run ?? ((file, args) => execute(file, args, { timeout: 12_000, maxBuffer: 1024 }));
  let statusCode: number | undefined;
  try {
    const result = await run(curl, [
      "--fail", "--silent", "--connect-timeout", "5", "--max-time", "10",
      "--user-agent", "cloudflare-origin-probe/1", "--output", "/dev/null", "--write-out", "%{http_code}", origin,
    ]);
    statusCode = Number(result.stdout.trim());
    if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 400) throw new Error("invalid origin response");
    operation.finish("succeeded", { ready: true, statusCode });
    return true;
  } catch (error) {
    const output = error && typeof error === "object" && "stdout" in error ? error.stdout : undefined;
    if (typeof output === "string" && /^\d{3}$/.test(output.trim())) statusCode = Number(output.trim());
    operation.finish("failed", {
      ready: false,
      ...(statusCode !== undefined && statusCode > 0 ? { statusCode } : {}),
      errorCode: safeErrorCode(error),
      reasonCode: statusCode !== undefined && statusCode >= 400 ? "origin_http_error" : "origin_unreachable",
    });
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [app, curl, origin] = process.argv.slice(2);
  if (!app || !curl || !origin) process.exitCode = 1;
  else process.exitCode = await checkOrigin(app, origin, curl) ? 0 : 1;
}
