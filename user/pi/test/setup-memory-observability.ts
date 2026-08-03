import { setMemoryWideEventFactoryForTests } from "../packages/core/agent-memory/observability.js";

setMemoryWideEventFactoryForTests(() => ({
  id: "vitest",
  set: () => undefined,
  error: () => undefined,
  finish: () => undefined,
}));
