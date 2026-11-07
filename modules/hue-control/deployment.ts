export const DEPLOYMENT_PLACEHOLDER = "__HUE_HOST_DEPLOYMENT_ID__";
export interface Deployment { schemaVersion: 1; deploymentId: string }
export function parseDeployment(value: unknown): Deployment {
  const data = value as Partial<Deployment> | null;
  if (!data || Array.isArray(data) || data.schemaVersion !== 1 || typeof data.deploymentId !== "string" || !/^[a-f0-9]{64}$/.test(data.deploymentId)) {
    throw Object.assign(new Error("invalid deployment metadata"), { code: "INVALID_DEPLOYMENT_METADATA" });
  }
  return { schemaVersion: 1, deploymentId: data.deploymentId };
}
/** The host installer replaces this literal BEFORE signing. A live receipt could misidentify an old process after replacement. */
export function runningDeployment(): Deployment | undefined {
  return /^[a-f0-9]{64}$/.test(DEPLOYMENT_PLACEHOLDER)
    ? { schemaVersion: 1, deploymentId: DEPLOYMENT_PLACEHOLDER } : undefined;
}
