#!/usr/bin/env node
import { processContext } from "./context.js";
import { run } from "./run.js";

process.exitCode = await run(process.argv.slice(2), processContext());
