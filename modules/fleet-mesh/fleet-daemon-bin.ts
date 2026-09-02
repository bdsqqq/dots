#!/usr/bin/env node

import { fleetDaemonMain } from "./fleet-daemon-main.ts";

process.exitCode = await fleetDaemonMain();
