import { createHash } from "node:crypto";

import type { StableIdentity } from "./ingest.ts";

function encodePart(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return Buffer.concat([length, bytes]);
}

export class NodeSha256Identity implements StableIdentity {
  digest(namespace: string, parts: readonly string[]): string {
    const hash = createHash("sha256");
    hash.update(encodePart(namespace));
    hash.update(encodePart(String(parts.length)));
    for (const part of parts) hash.update(encodePart(part));
    return hash.digest("hex");
  }
}
