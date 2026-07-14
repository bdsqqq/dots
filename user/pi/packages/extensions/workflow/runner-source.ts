export const WORKFLOW_RUNNER_SOURCE: string = String.raw`
"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const { createContext, Script } = require("node:vm");

const VERSION = 1;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
let input = Buffer.alloc(0);
let started = false;
let terminal = false;
let nextRequestId = 0;
const pending = new Map();
const inFlight = new Set();
const contexts = new AsyncLocalStorage();
let currentPhase;
let currentPhaseNodeId;
let graphSequence = 0;
let emittedGraphNodes = 0;
let emittedGraphBytes = 0;
let graphOverflowSent = false;
const MAX_EMITTED_GRAPH_NODES = 1999;
const MAX_EMITTED_GRAPH_BYTES = 1024 * 1024;
const GRAPH_OVERFLOW_RESERVE_BYTES = 512;

function wireError(error) {
  return {
    name: error && typeof error === "object" && typeof error.name === "string" ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function encode(frame) {
  const payload = Buffer.from(JSON.stringify({ v: VERSION, ...frame }), "utf8");
  if (payload.length > MAX_FRAME_BYTES) throw new Error("workflow protocol frame is too large");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

function send(frame, callback) {
  if (terminal && frame.type !== "fatal" && frame.type !== "complete") return;
  process.stdout.write(encode(frame), callback);
}

function finish(frame) {
  if (terminal) return;
  let encoded;
  try {
    encoded = encode(frame);
  } catch (error) {
    frame = { type: "fatal", error: wireError(error) };
    encoded = encode(frame);
  }
  terminal = true;
  process.stdin.pause();
  process.stdout.write(encoded, () => process.exit(frame.type === "complete" ? 0 : 1));
}

function activeContext() {
  return contexts.getStore() ?? {
    parentId: currentPhaseNodeId ?? "workflow",
    phase: currentPhase,
  };
}

function boundedGraphText(value, maxBytes) {
  const text = String(value);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end) + "…", "utf8") > maxBytes) end--;
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end) + "…";
}

function emitGraphEvent(event, reserveOverflow = true) {
  const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
  const limit = MAX_EMITTED_GRAPH_BYTES - (reserveOverflow ? GRAPH_OVERFLOW_RESERVE_BYTES : 0);
  if (emittedGraphBytes + bytes > limit) return false;
  emittedGraphBytes += bytes;
  send({ type: "graph", event });
  return true;
}

function emitGraphOverflow() {
  if (graphOverflowSent) return;
  graphOverflowSent = true;
  emittedGraphNodes++;
  emitGraphEvent({
    type: "node",
    node: {
      id: "workflow:overflow",
      parentId: "workflow",
      kind: "item",
      label: "additional control-flow nodes hidden",
      status: "running",
      order: Number.MAX_SAFE_INTEGER,
    },
  }, false);
}

function graphNode(kind, label, parentId, phase) {
  const id = kind + ":" + (++graphSequence);
  if (emittedGraphNodes >= MAX_EMITTED_GRAPH_NODES - 1) {
    emitGraphOverflow();
    return undefined;
  }
  const event = {
    type: "node",
    node: {
      id,
      parentId,
      kind,
      label: boundedGraphText(label, 512),
      status: "running",
      order: graphSequence,
      phase: phase === undefined ? undefined : boundedGraphText(phase, 256),
    },
  };
  if (!emitGraphEvent(event)) {
    emitGraphOverflow();
    return undefined;
  }
  emittedGraphNodes++;
  return id;
}

function graphStatus(id, status) {
  if (id) emitGraphEvent({ type: "status", id, status });
}

function trackedAgent(prompt, options = {}) {
  if (typeof prompt !== "string" || prompt.trim() === "") {
    return Promise.reject(new Error("agent prompt must be a non-empty string"));
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return Promise.reject(new Error("agent options must be an object"));
  }
  const id = String(++nextRequestId);
  const context = activeContext();
  const phase = options.phase ?? context.phase ?? currentPhase;
  const label = typeof options.label === "string" && options.label.trim()
    ? options.label.trim()
    : prompt.trim().split("\n")[0].slice(0, 80);
  const graphNodeId = graphNode("agent", label, context.parentId, phase);
  try {
    send({ type: "agent", id, prompt, options, phase, graphNodeId });
  } catch (error) {
    graphStatus(graphNodeId, "failed");
    throw error;
  }
  const promise = new Promise((resolve, reject) =>
    pending.set(id, { resolve, reject, graphNodeId }),
  );
  inFlight.add(promise);
  void promise.then(
    () => inFlight.delete(promise),
    () => inFlight.delete(promise),
  );
  void promise.catch(() => undefined);
  return promise;
}

function phaseDispatch(name, fn) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("phase name must be a non-empty string");
  }
  if (fn === undefined) {
    graphStatus(currentPhaseNodeId, "completed");
    currentPhase = name;
    currentPhaseNodeId = graphNode("phase", name, "workflow", name);
    return undefined;
  }
  if (typeof fn !== "function") throw new Error("phase callback must be a function");
  const context = activeContext();
  const nodeId = graphNode("phase", name, context.parentId, name);
  return contexts.run({ parentId: nodeId, phase: name }, async () => {
    try {
      const value = await fn();
      graphStatus(nodeId, "completed");
      return value;
    } catch (error) {
      graphStatus(nodeId, "failed");
      throw error;
    }
  });
}

function parallelDispatch(thunks) {
  if (!Array.isArray(thunks) || !thunks.every(thunk => typeof thunk === "function")) {
    throw new Error("parallel expects an array of functions");
  }
  const context = activeContext();
  const nodeId = graphNode("parallel", thunks.length + " branches", context.parentId, context.phase);
  return Promise.all(
    thunks.map(thunk =>
      contexts.run(
        { parentId: nodeId, phase: context.phase },
        () => Promise.resolve().then(thunk),
      ),
    ),
  ).then(
    value => {
      graphStatus(nodeId, "completed");
      return value;
    },
    error => {
      graphStatus(nodeId, "failed");
      throw error;
    },
  );
}

function pipelineDispatch(items, stages) {
  if (!Array.isArray(items) || !Array.isArray(stages) || !stages.every(stage => typeof stage === "function")) {
    throw new Error("pipeline expects items followed by stage functions");
  }
  const context = activeContext();
  const nodeId = graphNode(
    "pipeline",
    items.length + " items × " + stages.length + " stages",
    context.parentId,
    context.phase,
  );
  return Promise.all(
    items.map(async (item, index) => {
      const itemId = graphNode("item", "item " + (index + 1), nodeId, context.phase);
      let value = item;
      let parentId = itemId;
      try {
        for (let stageIndex = 0; stageIndex < stages.length; stageIndex++) {
          const stageId = graphNode(
            "stage",
            "stage " + (stageIndex + 1),
            parentId,
            context.phase,
          );
          try {
            value = await contexts.run(
              { parentId: stageId, phase: context.phase },
              () => stages[stageIndex](value, index),
            );
            graphStatus(stageId, "completed");
          } catch (error) {
            graphStatus(stageId, "failed");
            throw error;
          }
          parentId = stageId;
        }
        graphStatus(itemId, "completed");
        return value;
      } catch (error) {
        graphStatus(itemId, "failed");
        throw error;
      }
    }),
  ).then(
    value => {
      graphStatus(nodeId, "completed");
      return value;
    },
    error => {
      graphStatus(nodeId, "failed");
      throw error;
    },
  );
}

async function drainAgents() {
  do {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    await Promise.resolve();
  } while (inFlight.size > 0);
}

async function run(frame) {
  const bridge = {
    __agentDispatch: trackedAgent,
    __phaseDispatch: phaseDispatch,
    __parallelDispatch: parallelDispatch,
    __pipelineDispatch: pipelineDispatch,
    __argsJson: frame.args === undefined ? undefined : JSON.stringify(frame.args),
  };
  const context = createContext(Object.assign(Object.create(null), bridge), {
    name: "workflow-runner",
    codeGeneration: { strings: false, wasm: false },
  });
  const bootstrapSource = [
    "((agentDispatch, phaseDispatch, parallelDispatch, pipelineDispatch, argsJson) => {",
    "const SafeError = Error;",
    "const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));",
    "const cleanError = error => new SafeError(error && typeof error.message === 'string' ? error.message : String(error));",
    "const agentStates = new Set();",
    "const trackPromise = promise => {",
    "const state = { observed: false, error: undefined };",
    "agentStates.add(state);",
    "void promise.then(undefined, error => { state.error = cleanError(error); });",
    "const derive = next => { state.observed = true; return trackPromise(next); };",
    "return Object.freeze({",
    "then(resolve, reject) { return derive(promise.then(resolve, reject)); },",
    "catch(reject) { return derive(promise.catch(reject)); },",
    "finally(callback) { return derive(promise.finally(callback)); },",
    "});",
    "};",
    "const agent = (prompt, options = {}) => trackPromise((async () => {",
    "try { return clone(await agentDispatch(prompt, options)); }",
    "catch (error) { throw cleanError(error); }",
    "})());",
    "const drainAgentErrors = () => {",
    "for (const state of agentStates) if (!state.observed && state.error) throw state.error;",
    "};",
    "const parallel = thunks => (async () => {",
    "try { return clone(await parallelDispatch(thunks)); }",
    "catch (error) { throw cleanError(error); }",
    "})();",
    "const pipeline = (items, ...stages) => (async () => {",
    "try { return clone(await pipelineDispatch(items, stages)); }",
    "catch (error) { throw cleanError(error); }",
    "})();",
    "const phase = (name, fn) => {",
    "if (fn === undefined) return phaseDispatch(name);",
    "return (async () => {",
    "try { return clone(await phaseDispatch(name, fn)); }",
    "catch (error) { throw cleanError(error); }",
    "})();",
    "};",
    "Object.defineProperties(globalThis, {",
    "agent: { value: agent, enumerable: true },",
    "parallel: { value: parallel, enumerable: true },",
    "pipeline: { value: pipeline, enumerable: true },",
    "phase: { value: phase, enumerable: true },",
    "args: { value: argsJson === undefined ? undefined : JSON.parse(argsJson), enumerable: true },",
    "__workflowDrainAgentErrors: { value: drainAgentErrors },",
    "});",
    "})(__agentDispatch, __phaseDispatch, __parallelDispatch, __pipelineDispatch, __argsJson);",
    "delete globalThis.__agentDispatch;",
    "delete globalThis.__phaseDispatch;",
    "delete globalThis.__parallelDispatch;",
    "delete globalThis.__pipelineDispatch;",
    "delete globalThis.__argsJson;",
  ].join("\n");
  new Script(bootstrapSource, { filename: "workflow-bootstrap.js" }).runInContext(context);
  const script = new Script("(async () => {\n" + frame.body + "\n})()", {
    filename: frame.filename || "inline-workflow.js",
  });
  const value = await script.runInContext(context);
  await drainAgents();
  await new Promise(resolve => setImmediate(resolve));
  await drainAgents();
  new Script("globalThis.__workflowDrainAgentErrors()", {
    filename: "workflow-drain.js",
  }).runInContext(context);
  graphStatus(currentPhaseNodeId, "completed");
  finish({
    type: "complete",
    pending: pending.size,
    hasValue: value !== undefined,
    ...(value === undefined ? {} : { value }),
  });
}

function handle(frame) {
  if (!frame || typeof frame !== "object" || frame.v !== VERSION || typeof frame.type !== "string") {
    throw new Error("invalid workflow protocol frame");
  }
  if (frame.type === "start") {
    if (started || typeof frame.body !== "string") throw new Error("invalid workflow start frame");
    started = true;
    void run(frame).catch(error => finish({ type: "fatal", error: wireError(error) }));
    return;
  }
  if (frame.type === "agent_result") {
    const request = pending.get(frame.id);
    if (!request) throw new Error("workflow response has an unknown request id");
    pending.delete(frame.id);
    if (frame.ok) {
      graphStatus(request.graphNodeId, frame.cached ? "cached" : "completed");
      request.resolve(frame.value);
    } else {
      graphStatus(request.graphNodeId, "failed");
      request.reject(Object.assign(new Error(frame.error?.message || "workflow agent failed"), { name: frame.error?.name || "Error" }));
    }
    return;
  }
  throw new Error("unknown workflow protocol frame type: " + frame.type);
}

process.stdin.on("data", chunk => {
  if (terminal) return;
  try {
    input = Buffer.concat([input, chunk]);
    while (input.length >= 4) {
      const length = input.readUInt32BE(0);
      if (length < 2 || length > MAX_FRAME_BYTES) throw new Error("invalid workflow protocol frame length");
      if (input.length < length + 4) break;
      const payload = input.subarray(4, length + 4);
      input = input.subarray(length + 4);
      handle(JSON.parse(payload.toString("utf8")));
    }
  } catch (error) {
    finish({ type: "fatal", error: wireError(error) });
  }
});
process.stdin.on("end", () => finish({ type: "fatal", error: { name: "Error", message: "workflow protocol input closed" } }));
process.stdin.on("error", error => finish({ type: "fatal", error: wireError(error) }));
setInterval(() => send({ type: "heartbeat", pending: pending.size }), 1000).unref();
send({ type: "ready" });
`;
