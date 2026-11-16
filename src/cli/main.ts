#!/usr/bin/env node
import "./warnings.js";
import { processContext } from "./context.js";
import { run } from "./run.js";

process.exitCode = await run(process.argv.slice(2), processContext());
