#!/usr/bin/env node
import {configuration} from './config.js';
import {gestor, intake} from './runner.js';
import {readResult} from './result.js';

const help = `orca-agent-runner / oar

  oar run --spec SPEC.md --repo /path/to/repo --task implement -- executable arg
  oar run --spec SPEC.md --repo /path/to/repo --dry-run
  oar intake --spec SPEC.md
  oar result --file RESULT.md
  oar cleanup

Flags: --config FILE, --repo DIR, --spec FILE, --state-dir DIR,
       --task ID (repeatable), --dry-run, --file FILE, --help
Config: .oarrc JSON. Precedence: flags > OAR_* environment > config > defaults.
All relative paths resolve from the current working directory.
Workers receive SPEC on stdin, OAR_TASK, OAR_SPEC_PATH, OAR_RESULT_PATH, OAR_RUN_ID.
Local sessions are cleaned during run. Worktrees and results are always preserved.
`;

try {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const runnerArgs = separator < 0 ? args : args.slice(0, separator);
  if (runnerArgs.includes('--help')) process.stdout.write(help);
  else {
    const {config, action, file} = await configuration(process.argv.slice(2));
    switch (action) {
      case 'run': {
        const output = await gestor(config);
        process.stdout.write(JSON.stringify(config.dryRun ? {...output, plan: {repo: config.repo, spec: config.spec,
          stateDir: config.stateDir, tasks: config.tasks, command: config.command}, notice: 'DRY RUN: no workers started, no files created'} : output, null, 2) + '\n');
        break;
      }
      case 'intake': process.stdout.write(await intake(config.spec)); break;
      case 'result': process.stdout.write(await readResult(file)); break;
      case 'cleanup': process.stdout.write('Local cleanup is automatic within run. No owned live sessions exist in this new process; no terminals closed.\n'); break;
      default: throw new Error(`Unknown command: ${action}`);
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
