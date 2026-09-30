#!/usr/bin/env node
// Executable entrypoint; command construction and dependency injection live in
// cli.ts so diagnostics can be tested without spawning the MCP server.

import { runCli } from './cli.js';

await runCli();
