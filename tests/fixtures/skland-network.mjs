import { readFileSync, writeFileSync } from 'node:fs';
import { createSklandDouble } from './skland-double.mjs';

// Test-only: replaces the network boundary of a spawned CLI with the Skland double. Settings,
// credential files, snapshot files and the CLI itself stay real.
const scenario = process.env.MAA_SKLAND_TEST_SCENARIO ? JSON.parse(readFileSync(process.env.MAA_SKLAND_TEST_SCENARIO, 'utf8')) : {};
const double = createSklandDouble(scenario);
globalThis.fetch = double.fetch;
process.on('exit', () => { if (process.env.MAA_SKLAND_TEST_TRACE) writeFileSync(process.env.MAA_SKLAND_TEST_TRACE, JSON.stringify(double.trace)); });
