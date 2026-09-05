#!/usr/bin/env node
import { runCli } from '../dist-cli/cli/index.js'
process.exitCode = await runCli()