#!/usr/bin/env node
import { runSourceSync } from '../packages/bot/src/research-import/source-sync.js';
await runSourceSync(process.argv.slice(2));
