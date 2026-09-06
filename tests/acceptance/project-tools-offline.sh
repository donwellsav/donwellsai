#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
policy='(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*") (remote unix-socket))'
# This restriction applies only to these test processes. Chromium cannot nest its own sandbox here.
/usr/bin/sandbox-exec -p "$policy" /usr/bin/env node -e '
const net=require("node:net"),assert=require("node:assert/strict");
const socket=net.createConnection({host:"198.51.100.1",port:443});
socket.setTimeout(3000,()=>{socket.destroy();process.exitCode=1});
socket.once("connect",()=>{socket.destroy();process.exitCode=1});
socket.once("error",error=>{assert(["EPERM","EACCES"].includes(error.code),error.code);console.log("External network denied: "+error.code)});
'
/usr/bin/sandbox-exec -p "$policy" /usr/bin/env pnpm exec vitest run tests/project-doctor.test.ts tests/project-tools.test.ts tests/project-documents.test.ts tests/project-session-history.test.ts tests/project-task-coordination.test.ts
