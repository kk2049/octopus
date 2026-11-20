#!/usr/bin/env node
import { runResearchImport } from '../packages/bot/src/research-import/cli.js';
import * as actions from '../packages/research-program-view/app/actions.js';
import { project, projectIncremental } from '../packages/research-program-view/app/projection.js';
try {
    await runResearchImport(process.argv.slice(2), {
        project, incremental: projectIncremental,
        invoke: (action, context, params) => {
            const handler = (actions as Record<string, any>)[action];
            if (typeof handler !== 'function')
                throw new Error('Unknown research action');
            return handler(context, params);
        },
    });
}
catch (error) {
    process.stderr.write(`research import: ${error instanceof Error ? error.message : 'failed'}\n`);
    process.exitCode = 1;
}
