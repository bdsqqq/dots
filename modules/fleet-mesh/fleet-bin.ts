#!/usr/bin/env node

import { fleetCliMain } from "./fleet-cli-main.ts";

process.exitCode = await fleetCliMain();
