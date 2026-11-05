import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCapabilities, sanitizeField, schemaPath } from "../src/discovery.ts";
import { sourceInventory } from "../scripts/har.ts";
import type { Capability } from "../src/protocol.ts";
import { sdk, ok } from "./helpers.ts";

const root: Capability = {
  name: "Device",
  type: "xmo:node",
  flags: { node: true },
  attributes: [{ name: "Things", type: "xmo:list xmo:container", flags: { list: true } }],
};
const thing: Capability = {
  name: "Thing",
  type: "xmo:node",
  flags: { node: true },
  attributes: [
    {
      name: "Enabled",
      type: "xmo:boolean xmo:value",
      flags: { value: true, config: true },
      "default-value": "secret-default",
      description: "secret-description",
    },
  ],
  interfaces: [
    {
      name: "FixtureInterface",
      commands: [
        {
          name: "test",
          "input-parameters": [
            { name: "Count", type: "xmo:uint32 xmo:number xmo:value", flags: { value: true } },
          ],
        },
      ],
    },
  ],
};
function fixture() {
  const paths: string[] = [];
  const client = sdk((r) => {
    const actions = r.actions.map((a) => {
      paths.push(a.xpath!);
      const cap =
        a.xpath === "Device"
          ? root
          : a.xpath === "Device/Things"
            ? root.attributes![0]!
            : a.xpath === "Device/Things/*"
              ? thing
              : undefined;
      return {
        id: a.id,
        error: cap ? ok : { code: 16777242, description: "unknown" },
        ...(cap
          ? {
              callbacks: [1, 2].slice(0, a.xpath?.endsWith("*") ? 2 : 1).map((uid) => ({
                result: ok,
                xpath: a.xpath?.endsWith("*") ? `Device/Things/Thing[@uid='${uid}']` : a.xpath,
                parameters: {
                  capability: cap,
                  value: { Password: "secret-live", Device: { Password: "also-secret" } },
                },
              })),
            }
          : {}),
      };
    });
    return new Response(
      JSON.stringify({
        reply: {
          id: r.id,
          error: {
            code: actions.some((a) => a.error.code !== 16777238) ? 16777236 : 16777216,
            description: "fixture",
          },
          actions,
        },
      }),
    );
  });
  return { client, paths };
}

test("capability traversal finds wildcard instance schemas, preserves input signatures, and never retains values/defaults", async () => {
  const { client, paths } = fixture();
  const c = await discoverCapabilities(client, { seeds: ["Device/Unsupported"], batchSize: 2 });
  assert.equal(c.coverage.limitsReached, false);
  assert.ok(paths.includes("Device/Things/*"));
  assert.equal(new Set(paths).size, paths.length);
  const field = c.nodes.find((n) => n.path === "Device/Things/Thing/Enabled");
  assert.deepEqual(field?.selectors, ["Device/Things/Thing"]);
  assert.equal(field?.type, "xmo:boolean xmo:value");
  assert.deepEqual(
    c.nodes.find((n) => n.path === "Device/Things/Thing")?.commands[0]?.input.map((p) => p.name),
    ["Count"],
  );
  assert.ok(c.coverage.issues.some((i) => i.path === "Device/Unsupported" && i.code === 16777242));
  assert.doesNotMatch(
    JSON.stringify(c),
    /secret-live|also-secret|secret-default|secret-description/,
  );
  assert.ok(paths.every((p) => p.startsWith("Device")));
});

test("discovery limits and cancellation are explicit rather than silent completeness claims", async () => {
  const { client, paths } = fixture();
  const limited = await discoverCapabilities(client, { maxPaths: 1 });
  assert.equal(limited.coverage.limitsReached, true);
  assert.equal(paths.length, 1);
  await assert.rejects(discoverCapabilities(client, { batchSize: 91 }), TypeError);
  await assert.rejects(discoverCapabilities(client, { signal: AbortSignal.abort() }));
  assert.equal(paths.length, 1);
});

test("sanitization is metadata-only and schema paths remove all concrete identities", () => {
  assert.equal(
    schemaPath("Device/Users/User[Login='private-user']/Thing[@uid='7']/Name"),
    "Device/Users/User/Thing/Name",
  );
  const clean = sanitizeField({
    name: "Field",
    type: "xmo:str xmo:value",
    flags: { config: true },
    restrictions: { "max-length": 8, secret: "not-metadata" },
    "default-value": "password",
  });
  assert.deepEqual(clean, {
    name: "Field",
    type: "xmo:str xmo:value",
    flags: { config: true },
    restrictions: { "max-length": 8 },
  });
});

test("source inventory uses parsed literals, not comments, regexes, dynamic paths or credential values", () => {
  const dir = mkdtempSync(join(tmpdir(), "router-har-test-"));
  try {
    const source = [
      "const alias='Device/Real'; const branch=true?'Device/Second':'Device/Third';",
      "// 'Device/Comment'",
      "const re=/Device\\/NotLiteral/; const dynamic=`Device/${name}`; const fixed=`Device/Static`;",
      "const near='notDevice/No'; const partial='Device/Incomplete/';",
      "client.remoteCall('Device','fixtureCommand',{password:'do-not-retain'});",
      "const errors={XMO_FIXTURE_ERR:123}; const request={method:'getValue'}; const uri='/cgi/json-req';",
    ].join("\n");
    const har = join(dir, "fixture.har");
    writeFileSync(
      har,
      JSON.stringify({
        log: {
          entries: [
            {
              request: { url: "http://192.168.0.1/gui.js" },
              response: { content: { text: source } },
            },
          ],
        },
      }),
    );
    const inventory = sourceInventory(har);
    assert.deepEqual([...new Set(inventory.paths.map((p) => p.path))].sort(), [
      "Device",
      "Device/Real",
      "Device/Second",
      "Device/Static",
      "Device/Third",
    ]);
    assert.deepEqual(inventory.errorCodes, { XMO_FIXTURE_ERR: 123 });
    assert.equal(inventory.frontendCommands[0]?.method, "fixtureCommand");
    assert.equal(source[inventory.frontendCommands[0]!.offset], "'");
    assert.deepEqual(inventory.endpoints, ["/cgi/json-req"]);
    assert.doesNotMatch(JSON.stringify(inventory), /do-not-retain/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
