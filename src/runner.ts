import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat, mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import {join, relative, isAbsolute, resolve, dirname, basename, sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {taskId, type Config} from './config.js';
import {cleanup, LocalTerminalAdapter, type TerminalAdapter, type TerminalHandle} from './terminal.js';
import {result} from './result.js';

const execute = promisify(execFile);
async function git(repo: string, args: string[]): Promise<string> {
  return (await execute('git', ['-C', repo, ...args], {maxBuffer: 4 * 1024 * 1024})).stdout.trim();
}

export async function intake(path: string): Promise<string> {
  const spec = await readFile(path, 'utf8');
  if (!spec.trim()) throw new Error('SPEC.md must not be empty');
  return spec;
}

export interface WorkerResult {task: string; worktree: string; result: string}
export interface RunResult {dryRun: boolean; runDir?: string; workers: WorkerResult[]; closed: number}

async function canonicalPath(path: string): Promise<string> {
  try {return await realpath(path);}
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

async function validate(config: Config): Promise<void> {
  if (!config.tasks.length || new Set(config.tasks).size !== config.tasks.length) throw new Error('Tasks must be nonempty and unique');
  config.tasks.forEach(taskId);
  const root = await git(config.repo, ['rev-parse', '--show-toplevel']);
  if (await realpath(root) !== await realpath(config.repo)) throw new Error('repo must be the Git repository root');
  await git(config.repo, ['rev-parse', '--verify', 'HEAD']);
  if (await git(config.repo, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Repository is dirty; commit or stash changes before running');
  const relation = relative(await realpath(config.repo), await canonicalPath(config.stateDir));
  if (!relation || (!relation.startsWith('..' + sep) && relation !== '..' && !isAbsolute(relation))) {
    throw new Error('stateDir must be outside the source repository');
  }
  if (!config.dryRun && !config.command[0]) throw new Error('Execution requires an explicit worker command; use --dry-run to plan');
}

export async function worker(config: Config, task: string, runDir: string, owner: string,
  adapter: TerminalAdapter, handles: TerminalHandle[]): Promise<WorkerResult> {
  taskId(task);
  const directory = join(runDir, task);
  const worktree = join(directory, 'worktree');
  await mkdir(directory, {mode: 0o700});
  await git(config.repo, ['worktree', 'add', '--detach', worktree, 'HEAD']);
  const source = join(worktree, 'RESULT.md');
  // A tracked previous result must never count as this worker's output.
  try {await lstat(source); throw new Error('Worktree already contains RESULT.md; refusing stale completion');}
  catch (error) {if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;}
  const specPath = join(runDir, 'SPEC.md');
  const handle = await adapter.start({owner, cwd: worktree, command: config.command,
    input: await intake(specPath), logPath: join(directory, 'worker.log'),
    env: {OAR_TASK: task, OAR_SPEC_PATH: specPath, OAR_RESULT_PATH: source, OAR_RUN_ID: owner},
  });
  handles.push(handle);
  const exitCode = await adapter.wait(handle);
  if (exitCode !== 0) throw new Error(`Worker ${task} exited with code ${exitCode}`);
  const destination = join(directory, 'RESULT.md');
  await result(source, destination);
  return {task, worktree, result: destination};
}

/** Sequential manager: each task receives the same spec and its own OAR_TASK. */
export async function gestor(config: Config, adapter: TerminalAdapter = new LocalTerminalAdapter()): Promise<RunResult> {
  config = {...config, repo: resolve(config.repo), spec: resolve(config.spec), stateDir: resolve(config.stateDir)};
  const spec = await intake(config.spec);
  await validate(config);
  if (config.dryRun) return {dryRun: true, workers: [], closed: 0};
  await mkdir(config.stateDir, {recursive: true, mode: 0o700});
  // Canonical check also rejects a stateDir symlink pointing into the source repo.
  const canonical = await realpath(config.stateDir);
  const source = await realpath(config.repo);
  const rel = relative(source, canonical);
  if (!rel || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))) throw new Error('stateDir resolves inside the repository');
  const owner = randomUUID();
  const runDir = join(canonical, owner);
  await mkdir(runDir, {mode: 0o700});
  await writeFile(join(runDir, 'SPEC.md'), spec, {flag: 'wx', mode: 0o600});
  const handles: TerminalHandle[] = [];
  const workers: WorkerResult[] = [];
  let failure: Error | undefined;
  let cleanupError: string | undefined;
  let closed = 0;
  try {
    for (const task of config.tasks) workers.push(await worker(config, task, runDir, owner, adapter, handles));
  } catch (error) {failure = error instanceof Error ? error : new Error(String(error));}
  finally {
    try {closed = await cleanup(adapter, owner, handles);}
    catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
      failure ??= new Error(`Cleanup failed: ${cleanupError}`);
    }
  }
  const summary = {dryRun: false, runDir, workers, closed};
  await writeFile(join(runDir, 'run.json'), JSON.stringify({...summary, status: failure ? 'failed' : 'completed',
    error: failure?.message ?? null, cleanupError: cleanupError ?? null}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  if (failure) throw new Error(`Run failed; evidence preserved at ${runDir}: ${failure.message}${cleanupError ? `; cleanup: ${cleanupError}` : ''}`);
  return summary;
}
