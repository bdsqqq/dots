import { createHash } from "node:crypto";
import type { SagemcomXmoClient, RequestOptions } from "./client.ts";
import {
  ACTION_OK,
  CALLBACK_ERROR,
  REQUEST_OK,
  REQUEST_ACTION_ERROR,
  XmoError,
  record,
} from "./protocol.ts";
import type { Capability, Json, JsonObject, Reply, XmoCommand } from "./protocol.ts";

export interface FieldSchema {
  name: string;
  type: string;
  flags: Record<string, boolean>;
  restrictions?: JsonObject;
}
export interface CommandSchema {
  name: string;
  interface: string;
  input: FieldSchema[];
  output: FieldSchema[];
}
export interface SchemaNode extends FieldSchema {
  /** Unselected schema path: instances are selected by uid/alias in concrete XPaths. */
  path: string;
  /** Paths of list-element ancestors, including self when applicable. */
  selectors: string[];
  commands: CommandSchema[];
}
export interface SchemaCatalog {
  format: 1;
  identity: Record<string, string>;
  nodes: SchemaNode[];
  coverage: {
    requests: number;
    queriedPaths: string[];
    issues: { path: string; code: number | string }[];
    limitsReached: boolean;
  };
}
const restrictionKeys = new Set([
  "min-length",
  "max-length",
  "min-value-inclusive",
  "max-value-inclusive",
  "min-value-exclusive",
  "max-value-exclusive",
  "enum-values",
  "reg-exp",
]);
/** Only retain schema metadata. Actual values, defaults, descriptions, IDs and credentials never enter catalogs. */
export function sanitizeField(cap: Capability): FieldSchema {
  if (typeof cap.name !== "string" || !cap.name || typeof cap.type !== "string")
    throw new TypeError("capability missing name/type");
  const flags: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(cap.flags ?? {})) if (typeof v === "boolean") flags[k] = v;
  const restrictions: JsonObject = {};
  for (const [k, v] of Object.entries(cap.restrictions ?? {}))
    if (restrictionKeys.has(k)) {
      if (typeof v === "number" || typeof v === "string") restrictions[k] = v;
      if (k === "enum-values" && Array.isArray(v))
        restrictions[k] = v.flatMap((e) =>
          record(e) &&
          typeof e.name === "string" &&
          (typeof e.value === "string" || typeof e.value === "number")
            ? [{ name: e.name, value: e.value }]
            : [],
        );
      if (k === "reg-exp" && record(v) && typeof v.pattern === "string")
        restrictions[k] = { pattern: v.pattern, "ignore-case": v["ignore-case"] === true };
    }
  return {
    name: cap.name,
    type: cap.type,
    flags,
    ...(Object.keys(restrictions).length ? { restrictions } : {}),
  };
}
function sanitizeCommand(c: XmoCommand, iface: string): CommandSchema {
  return {
    name: c.name,
    interface: iface,
    input: (c["input-parameters"] ?? []).map(sanitizeField),
    output: (c["output-parameters"] ?? []).map(sanitizeField),
  };
}
export function schemaPath(xpath: string): string {
  return xpath.replace(/\[[^\]]*\]/g, "");
}
export function catalogDigest(catalog: SchemaCatalog): string {
  return createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
}

/** Read-only, breadth-first capability discovery. No remote commands or speculative paths are executed. */
export async function discoverCapabilities(
  client: SagemcomXmoClient,
  options: RequestOptions & {
    seeds?: readonly string[];
    maxPaths?: number;
    batchSize?: number;
    onProgress?: (progress: { queried: number; pending: number; nodes: number }) => void;
  } = {},
): Promise<SchemaCatalog> {
  const maxPaths = options.maxPaths ?? 5000;
  const batchSize = options.batchSize ?? 20;
  if (
    !Number.isSafeInteger(maxPaths) ||
    maxPaths < 1 ||
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 90
  )
    throw new TypeError("invalid discovery limits");
  const nodes = new Map<string, SchemaNode>();
  const pending = new Set([
    "Device",
    ...(options.seeds ?? []).flatMap((seed) => {
      const parts = schemaPath(seed).split("/");
      return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    }),
  ]);
  const queried = new Set<string>();
  const issues: SchemaCatalog["coverage"]["issues"] = [];
  let requests = 0;
  const identity: Record<string, string> = {};
  const identityNames = new Set([
    "Manufacturer",
    "ModelName",
    "ProductClass",
    "HardwareVersion",
    "SoftwareVersion",
    "GUIAPIVersion",
  ]);
  const ingest = (cap: Capability, path: string, selectors: string[]) => {
    const prior = nodes.get(path);
    const commands = (cap.interfaces ?? []).flatMap((i) =>
      (i.commands ?? []).map((c) => sanitizeCommand(c, i.name)),
    );
    const field = sanitizeField(cap);
    // Repeated instance schemas are merged, not replaced by the last instance in the response.
    const commandMap = new Map(
      [...(prior?.commands ?? []), ...commands].map((c) => [c.interface + "#" + c.name, c]),
    );
    nodes.set(path, {
      ...field,
      path,
      selectors: [...new Set([...(prior?.selectors ?? []), ...selectors])].sort(),
      commands: [...commandMap.values()].sort((a, b) =>
        (a.interface + a.name).localeCompare(b.interface + b.name),
      ),
    });
    // Containers omit their element schema. The read-only wildcard reveals existing
    // instance types without guessing singular names or creating a test instance.
    if (cap.type?.includes("xmo:container")) pending.add(`${path}/*`);
    for (const child of cap.attributes ?? []) {
      const childPath = `${path}/${child.name}`;
      ingest(child, childPath, selectors);
      if (!child.type?.includes("xmo:value")) pending.add(childPath);
    }
    for (const child of cap.children ?? []) {
      const childPath = `${path}/${child.name}`;
      const selected = cap.type?.includes("xmo:container") ? [...selectors, childPath] : selectors;
      ingest(child, childPath, selected);
      if (!child.type?.includes("xmo:value")) pending.add(childPath);
    }
  };
  while (pending.size && queried.size < maxPaths) {
    options.signal?.throwIfAborted();
    const batch = [...pending]
      .filter((p) => !queried.has(p))
      .slice(0, Math.min(batchSize, maxPaths - queried.size));
    if (!batch.length) break;
    for (const p of batch) {
      pending.delete(p);
      queried.add(p);
    }
    // A single denied/unknown seed must not discard successful siblings. Read checked partial replies.
    let reply: Reply;
    try {
      reply = await client.execute(
        batch.map((xpath) => ({
          method: "getValue",
          xpath,
          options: {
            "capability-flags": {
              name: true,
              interface: true,
              attributes: true,
              children: true,
              restriction: true,
            },
          },
        })),
        options,
      );
    } catch (error) {
      if (!(error instanceof XmoError)) throw error;
      if (![REQUEST_OK, REQUEST_ACTION_ERROR].includes(error.reply.error.code)) throw error;
      reply = error.reply;
    }
    requests++;
    for (const [i, path] of batch.entries()) {
      const action = reply.actions.find((a) => a.id === i);
      if (!action || ![ACTION_OK, CALLBACK_ERROR].includes(action.error.code)) {
        issues.push({ path, code: action?.error.code ?? "missing-action" });
        continue;
      }
      if (action.error.code === CALLBACK_ERROR) issues.push({ path, code: CALLBACK_ERROR });
      if (!action.callbacks?.length) {
        issues.push({ path, code: "no-capability-callback" });
        continue;
      }
      for (const cb of action.callbacks) {
        if (cb.result.code !== ACTION_OK || !cb.parameters?.capability) {
          issues.push({
            path,
            code: cb.result.code !== ACTION_OK ? cb.result.code : "missing-capability",
          });
          continue;
        }
        const canonical = schemaPath(cb.xpath ?? path);
        const selectors = [...(cb.xpath ?? path).matchAll(/\[[^\]]*\]/g)].map((m) =>
          schemaPath((cb.xpath ?? path).slice(0, m.index)),
        );
        ingest(cb.parameters.capability, canonical, selectors);
        if (canonical === "Device/DeviceInfo" && record(cb.parameters.value)) {
          const v = cb.parameters.value.DeviceInfo;
          if (record(v))
            for (const [key, val] of Object.entries(v))
              if (identityNames.has(key) && typeof val === "string") identity[key] = val;
        }
      }
    }
    options.onProgress?.({
      queried: queried.size,
      pending: [...pending].filter((p) => !queried.has(p)).length,
      nodes: nodes.size,
    });
  }
  return {
    format: 1,
    identity: Object.fromEntries(Object.entries(identity).sort()),
    nodes: [...nodes.values()].sort((a, b) => a.path.localeCompare(b.path)),
    coverage: {
      requests,
      queriedPaths: [...queried].sort(),
      issues: issues.sort((a, b) => a.path.localeCompare(b.path)),
      limitsReached: [...pending].some((p) => !queried.has(p)),
    },
  };
}

/** Primitive wire types are deliberately conservative: numeric enums may return names. */
export function fieldValueType(field: FieldSchema): "string" | "number" | "boolean" | "json" {
  if (
    field.type.includes("xmo:str") ||
    field.type.includes("xmo:time") ||
    field.type.includes("xmo:base64")
  )
    return "string";
  if (field.type.includes("xmo:boolean")) return "boolean";
  if (field.type.includes("xmo:number")) return "number";
  return "json";
}
export function validateFieldValue(field: FieldSchema, value: Json): void {
  const type = fieldValueType(field);
  const enums = field.restrictions?.["enum-values"];
  const enumMatch =
    Array.isArray(enums) &&
    enums.some((e) => record(e) && (e.name === value || String(e.value) === String(value)));
  if (type !== "json" && typeof value !== type && !enumMatch)
    throw new TypeError(`value does not match schema type (${type})`);
  if (Array.isArray(enums) && enums.length && !enumMatch)
    throw new TypeError("value is outside the advertised enum");
  const r = field.restrictions ?? {};
  if (typeof value === "string" && type === "string") {
    const length = Array.from(value).length;
    if (r["min-length"] !== undefined && length < Number(r["min-length"]))
      throw new TypeError("value is shorter than the schema minimum");
    if (r["max-length"] !== undefined && length > Number(r["max-length"]))
      throw new TypeError("value is longer than the schema maximum");
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("value must be finite");
    if (/xmo:u?int(?:8|16|32|64)\b/.test(field.type) && !Number.isSafeInteger(value))
      throw new TypeError("integer value must be a safe integer");
    const integerType = /xmo:(u?)int(8|16|32)\b/.exec(field.type);
    if (integerType) {
      const bits = Number(integerType[2]),
        unsigned = integerType[1] === "u";
      if (
        value < (unsigned ? 0 : -(2 ** (bits - 1))) ||
        value > (unsigned ? 2 ** bits - 1 : 2 ** (bits - 1) - 1)
      )
        throw new TypeError("integer is outside its wire range");
    }
    for (const [key, violated] of [
      ["min-value-inclusive", (bound: number) => value < bound],
      ["max-value-inclusive", (bound: number) => value > bound],
      ["min-value-exclusive", (bound: number) => value <= bound],
      ["max-value-exclusive", (bound: number) => value >= bound],
    ] as const)
      if (r[key] !== undefined && violated(Number(r[key])))
        throw new TypeError("value is outside the schema bounds");
  }
  // Regex constraints remain router-owned: executing firmware-supplied regexes can hang a caller.
}
