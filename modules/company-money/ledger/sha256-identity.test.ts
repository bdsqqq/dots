import assert from "node:assert/strict";
import test from "node:test";

import { NodeSha256Identity } from "./sha256-identity.ts";

test("identity hashing is stable and length-delimited", () => {
  const identity = new NodeSha256Identity();
  assert.equal(identity.digest("namespace", ["a", "bc"]), identity.digest("namespace", ["a", "bc"]));
  assert.notEqual(identity.digest("namespace", ["a", "bc"]), identity.digest("namespace", ["ab", "c"]));
  assert.notEqual(identity.digest("namespace", ["a"]), identity.digest("other", ["a"]));
  assert.match(identity.digest("namespace", []), /^[a-f0-9]{64}$/);
});
