import assert from "node:assert/strict";
import { test } from "node:test";
import { brokerInstance, creation, INSTANCE_ID, verifyAddition } from "./t3-presets.ts";

test("personal broker creates only a named existing CLI instance, never defaults or Claude", () => {
  const before={defaultModelSelection:{providerInstanceId:"codex_work"},providerInstances:{codex_work:{driver:"codex",config:{binaryPath:"/native/codex"}}}};
  const mutation=creation(before,"/home/bdsqqq")!;
  assert.deepEqual(mutation.patch,{});
  assert.equal(mutation.providerInstanceMutation.operation,"create");
  assert.equal(mutation.providerInstanceMutation.instance.config.setupMode,"existing");
  assert.equal(mutation.providerInstanceMutation.instance.config.binaryPath,"/home/bdsqqq/.local/bin/codex-broker");
  assert.ok(!JSON.stringify(mutation).includes("claude"));
  const after=structuredClone(before) as any;
  after.providerInstances[INSTANCE_ID]=brokerInstance("/home/bdsqqq");
  verifyAddition(before,after,"/home/bdsqqq");
  assert.equal(creation(after,"/home/bdsqqq"),undefined);
  after.defaultModelSelection={providerInstanceId:INSTANCE_ID};
  assert.throws(()=>verifyAddition(before,after,"/home/bdsqqq"),/unrelated/);
});

test("collisions, credential injection and auth-home overrides are rejected rather than repaired", () => {
  const before={providerInstances:{}};
  const after:any={providerInstances:{[INSTANCE_ID]:brokerInstance("/Users/bdsqqq")}};
  assert.throws(()=>brokerInstance("~"),/absolute/);
  after.providerInstances[INSTANCE_ID].config.binaryPath="/direct/codex";
  assert.throws(()=>creation(after,"/Users/bdsqqq"),/collision/);
  after.providerInstances[INSTANCE_ID]=brokerInstance("/Users/bdsqqq");
  after.providerInstances[INSTANCE_ID].environment=[{name:"OPENAI_API_KEY",value:"fixture"}];
  assert.throws(()=>verifyAddition(before,after,"/Users/bdsqqq"),/inline/);
  delete after.providerInstances[INSTANCE_ID].environment;
  after.providerInstances[INSTANCE_ID].config.shadowHomePath="/other/account";
  assert.throws(()=>verifyAddition(before,after,"/Users/bdsqqq"),/overrides/);
});
