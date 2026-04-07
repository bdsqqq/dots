#!/usr/bin/env bun
import { main } from "../packages/core/model-evals/index.js";

const exitCode = await main(Bun.argv.slice(2));
process.exit(exitCode);
