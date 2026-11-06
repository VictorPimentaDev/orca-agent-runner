import {readFile} from 'node:fs/promises';
import {resolve, dirname, basename} from 'node:path';
import {parseArgs} from 'node:util';

export interface Config {
  repo: string;
  spec: string;
  stateDir: string;
  tasks: string[];
  command: string[];
  dryRun: boolean;
}

export function taskId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) {
    throw new Error(`Invalid task ID: ${value}`);
  }
  return value;
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string' && !v.includes('\0'))) {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  return value;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${name} must be a nonempty string`);
  }
  return value;
}

export async function configuration(argv: string[], env = process.env, cwd = process.cwd()) {
  const {values, positionals} = parseArgs({args: argv, allowPositionals: true, options: {
    config: {type: 'string'}, repo: {type: 'string'}, spec: {type: 'string'},
    'state-dir': {type: 'string'}, task: {type: 'string', multiple: true},
    'dry-run': {type: 'boolean'}, help: {type: 'boolean'}, file: {type: 'string'},
  }});
  const configPath = resolve(cwd, values.config ?? env.OAR_CONFIG ?? '.oarrc');
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Config must be an object');
    data = Object.fromEntries(Object.entries(parsed));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT' && !values.config && !env.OAR_CONFIG)) throw error;
  }
  const allowed = new Set(['repo', 'spec', 'stateDir', 'tasks', 'command', 'dryRun']);
  for (const key of Object.keys(data)) if (!allowed.has(key)) throw new Error(`Unknown config field: ${key}`);
  const repo = resolve(cwd, string(values.repo ?? env.OAR_REPO ?? data.repo ?? '.', 'repo'));
  const spec = resolve(cwd, string(values.spec ?? env.OAR_SPEC ?? data.spec ?? 'SPEC.md', 'spec'));
  const stateDir = resolve(cwd, string(values['state-dir'] ?? env.OAR_STATE_DIR ?? data.stateDir ?? resolve(dirname(repo), '.oar', basename(repo)), 'stateDir'));
  const tasks = strings(values.task ?? (env.OAR_TASKS ? JSON.parse(env.OAR_TASKS) : data.tasks ?? ['task']), 'tasks').map(taskId);
  if (!tasks.length || new Set(tasks).size !== tasks.length) throw new Error('Tasks must be nonempty and unique');
  const command = strings(positionals.length > 1 ? positionals.slice(1) : env.OAR_COMMAND ? JSON.parse(env.OAR_COMMAND) : data.command ?? [], 'command');
  if (command.length && !command[0]?.trim()) throw new Error('Command executable must be nonempty');
  if (env.OAR_DRY_RUN !== undefined && !['true', 'false'].includes(env.OAR_DRY_RUN)) throw new Error('OAR_DRY_RUN must be true or false');
  const dryRun = values['dry-run'] ?? (env.OAR_DRY_RUN !== undefined ? env.OAR_DRY_RUN === 'true' : data.dryRun ?? false);
  if (typeof dryRun !== 'boolean') throw new Error('dryRun must be boolean');
  const config: Config = {repo, spec, stateDir, tasks, command, dryRun};
  return {config, action: positionals[0] ?? 'run', help: values.help ?? false, file: resolve(cwd, values.file ?? 'RESULT.md')};
}
