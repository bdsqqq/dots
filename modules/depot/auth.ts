import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

type Execute = (binary: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: "inherit" }) => {
  status: number | null;
  error?: Error;
};

/** adapt one invocation; never copy the organization token into native login state. */
export function runDepot({ binary, credentialFile, organizationId, configHome, args,
  env = process.env, execute = spawnSync,
}: {
  binary: string;
  credentialFile: string;
  organizationId: string;
  configHome: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  execute?: Execute;
}): number {
  if (!binary || !/^[a-z0-9]+$/.test(organizationId) || !configHome.startsWith("/")) {
    throw new Error("depot-org requires a native executable, explicit organization ID, and absolute config home");
  }
  let token: string;
  try { token = readFileSync(credentialFile, "utf8").trim(); }
  catch { throw new Error("depot organization credential is unreadable; provision sops and activate its runtime file"); }
  if (!token || /\s/.test(token)) {
    throw new Error("depot organization credential is empty or malformed; fill depot_org_token in modules/depot/secrets.yaml");
  }
  const result = execute(binary, args, {
    stdio: "inherit",
    env: {
      ...env,
      XDG_CONFIG_HOME: env.XDG_CONFIG_HOME || configHome,
      // flag-based API calls and Viper's stored-token consumers use different names.
      DEPOT_TOKEN: token,
      DEPOT_API_TOKEN: token,
      DEPOT_ORG_ID: organizationId,
    },
  });
  if (result.error) throw new Error("could not start the native Depot CLI");
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [binary = "", credentialFile = "", organizationId = "", configHome = "", ...args] = process.argv.slice(2);
  try { process.exitCode = runDepot({ binary, credentialFile, organizationId, configHome, args }); }
  catch (error) {
    console.error(error instanceof Error ? error.message : "depot-org failed");
    process.exitCode = 1;
  }
}
