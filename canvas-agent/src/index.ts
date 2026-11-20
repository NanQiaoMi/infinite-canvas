#!/usr/bin/env node
import { startHttpServer } from "./server/http.js";
import { runInstallMcp } from "./install-mcp.js";
import { startMcpServer } from "./server/mcp.js";

if (process.argv[2] === "install-mcp") await runInstallMcp(process.argv.slice(3));
else if (process.argv[2] === "mcp") await startMcpServer();
else startHttpServer();
