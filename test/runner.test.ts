import {afterEach, beforeAll, describe, expect, it} from 'vitest';
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {gestor, intake} from '../src/runner.js';
import {LocalTerminalAdapter} from '../src/terminal.js';
import type {TerminalHandle} from '../src/terminal.js';
import type {Config} from '../src/config.js';

const execute = promisify(execFile);
const roots: string[] = [];
const cli = resolve('dist/cli.js');
beforeAll(async () => {await execute(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']);});
afterEach(async () => {await Promise.all(roots.splice(0).map(path => rm(path, {recursive: true, force: true})));});
async function fixture(): Promise<Config> {
  const base = await mkdtemp(join(tmpdir(), 'oar-test-'));
  roots.push(base);
  const repo = join(base, 'repo with spaces');
  await mkdir(repo);
  await execute('git', ['init', '-q', repo]);
  await writeFile(join(repo, 'README.md'), '# Fixture\n');
  await execute('git', ['-C', repo, 'add', '.']);
  await execute('git', ['-C', repo, '-c', 'user.name=Test Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const spec = join(base, 'SPEC.md');
  await writeFile(spec, 'Implement the task, then write a truthful result.\n');
  return {repo, spec, stateDir: join(base, 'state'), tasks: ['first', 'second'], dryRun: false,
    command: [process.execPath, '--input-type=module', '-e', `
      import {readFile, writeFile} from 'node:fs/promises';
      const spec = await readFile(process.env.OAR_SPEC_PATH, 'utf8');
      if (!spec.includes('Implement')) process.exit(2);
      await writeFile('change.txt', process.env.OAR_TASK);
      await writeFile(process.env.OAR_RESULT_PATH, '# Mock fixture ' + process.env.OAR_TASK + '\\nFIM\\n');
      console.log('fixture executed');
    `]};
}

async function onlyRun(config: Config): Promise<string> {
  const dirs = await readdir(config.stateDir);
  expect(dirs).toHaveLength(1);
  const directory = dirs[0];
  if (!directory) throw new Error('Missing evidence');
  return join(config.stateDir, directory);
}

describe('intake → gestor → worker → result → cleanup', () => {
  it('runs real subprocesses in separate worktrees and preserves all evidence', async () => {
    const config = await fixture();
    expect(await intake(config.spec)).toContain('Implement');
    const run = await gestor(config);
    expect(run.dryRun).toBe(false);
    expect(run.closed).toBe(2);
    expect(run.workers).toHaveLength(2);
    expect(new Set(run.workers.map(w => w.worktree)).size).toBe(2);
    for (const worker of run.workers) {
      expect(await readFile(worker.result, 'utf8')).toBe(`# Mock fixture ${worker.task}\nFIM\n`);
      expect(await readFile(join(worker.worktree, 'change.txt'), 'utf8')).toBe(worker.task);
      expect(await readFile(join(worker.worktree, '..', 'worker.log'), 'utf8')).toContain('fixture executed');
    }
    expect((await execute('git', ['-C', config.repo, 'status', '--porcelain'])).stdout).toBe('');
    expect(JSON.parse(await readFile(join(await onlyRun(config), 'run.json'), 'utf8')).status).toBe('completed');
  });

  it('dry-run creates no state or worktrees and does not execute the command', async () => {
    const config = await fixture();
    const before = (await execute('git', ['-C', config.repo, 'worktree', 'list', '--porcelain'])).stdout;
    expect(await gestor({...config, dryRun: true, command: ['not-a-real-command']})).toEqual({dryRun: true, workers: [], closed: 0});
    await expect(readdir(config.stateDir)).rejects.toThrow();
    expect((await execute('git', ['-C', config.repo, 'worktree', 'list', '--porcelain'])).stdout).toBe(before);
  });

  it.each([
    ['exit failure', `console.error('intentional failure'); process.exit(7)`, 'code 7'],
    ['missing FIM', `require('fs').writeFileSync(process.env.OAR_RESULT_PATH, 'Incomplete')`, 'exact line FIM'],
    ['missing result', '', 'ENOENT'],
  ])('preserves failed worktree and manifest: %s', async (_name, script, message) => {
    const config = await fixture();
    config.command = [process.execPath, '-e', script];
    await expect(gestor(config)).rejects.toThrow(message);
    const run = await onlyRun(config);
    const manifest = JSON.parse(await readFile(join(run, 'run.json'), 'utf8'));
    expect(manifest.status).toBe('failed');
    expect(manifest.closed).toBe(1);
    expect(await readdir(join(run, 'first', 'worktree'))).toContain('README.md');
    await expect(readdir(join(run, 'second'))).rejects.toThrow();
  });

  it('cleans a session whose executable does not exist', async () => {
    const config = await fixture();
    config.command = ['oar-test-command-does-not-exist'];
    await expect(gestor(config)).rejects.toThrow('ENOENT');
    const manifest = JSON.parse(await readFile(join(await onlyRun(config), 'run.json'), 'utf8'));
    expect(manifest.closed).toBe(1);
  });

  it('refuses dirty repositories without discarding user changes', async () => {
    const config = await fixture();
    await writeFile(join(config.repo, 'README.md'), 'Uncommitted work');
    await expect(gestor(config)).rejects.toThrow('dirty');
    expect(await readFile(join(config.repo, 'README.md'), 'utf8')).toBe('Uncommitted work');
    await expect(readdir(config.stateDir)).rejects.toThrow();
  });

  it('rejects a tracked stale RESULT.md', async () => {
    const config = await fixture();
    await writeFile(join(config.repo, 'RESULT.md'), '# Stale\nFIM\n');
    await execute('git', ['-C', config.repo, 'add', '.']);
    await execute('git', ['-C', config.repo, '-c', 'user.name=Test Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'stale result']);
    await expect(gestor(config)).rejects.toThrow('stale completion');
  });

  it('requires an explicit command for real work', async () => {
    const config = await fixture();
    await expect(gestor({...config, command: []})).rejects.toThrow('explicit worker command');
    await expect(readdir(config.stateDir)).rejects.toThrow();
  });

  it.each(['../escape', '/absolute', '..', 'a/b', '-flag', 'a b'])('rejects unsafe task ID %s', async id => {
    const config = await fixture();
    await expect(gestor({...config, tasks: [id]})).rejects.toThrow('Invalid task ID');
    await expect(readdir(config.stateDir)).rejects.toThrow();
  });

  it('rejects state paths inside the repo, including through a symlink', async () => {
    const config = await fixture();
    await expect(gestor({...config, stateDir: join(config.repo, 'state')})).rejects.toThrow('outside');
    const link = join(config.repo, '..', 'link');
    await symlink(config.repo, link, 'dir');
    await expect(gestor({...config, stateDir: join(link, 'new', 'state')})).rejects.toThrow('outside');
    await expect(readdir(join(config.repo, 'new'))).rejects.toThrow();
  });
});


it.each(['isIdle', 'close'])('writes the failed manifest even when adapter.%s throws', async method => {
  const config = await fixture();
  config.tasks = ['first'];
  config.command = [process.execPath, '-e', 'process.exit(9)'];
  class BrokenCleanup extends LocalTerminalAdapter {
    override async isIdle(handle: TerminalHandle): Promise<boolean> {
      if (method === 'isIdle') throw new Error('cleanup fixture failure');
      return super.isIdle(handle);
    }
    override async close(handle: TerminalHandle): Promise<void> {
      if (method === 'close') throw new Error('cleanup fixture failure');
      return super.close(handle);
    }
  }
  await expect(gestor(config, new BrokenCleanup())).rejects.toThrow('code 9; cleanup: cleanup fixture failure');
  const manifest = JSON.parse(await readFile(join(await onlyRun(config), 'run.json'), 'utf8'));
  expect(manifest.status).toBe('failed');
  expect(manifest.error).toContain('code 9');
  expect(manifest.cleanupError).toBe('cleanup fixture failure');
});

it('CLI forwards worker --help after the delimiter instead of intercepting it', async () => {
  const config = await fixture();
  const script = "require('fs').writeFileSync(process.env.OAR_RESULT_PATH, '# Forwarded ' + process.argv[1] + '\\nFIM\\n')";
  const {stdout} = await execute(process.execPath, [cli, 'run', '--repo', config.repo, '--spec', config.spec,
    '--state-dir', config.stateDir, '--task', 'forwarded', '--', process.execPath, '-e', script, '--', '--help']);
  const report = JSON.parse(stdout);
  expect(report.dryRun).toBe(false);
  expect(await readFile(report.workers[0].result, 'utf8')).toContain('# Forwarded --help');
});

it('CLI exits nonzero for a worker result without FIM', async () => {
  const config = await fixture();
  await expect(execute(process.execPath, [cli, 'run', '--repo', config.repo, '--spec', config.spec,
    '--state-dir', config.stateDir, '--', process.execPath, '-e', "require('fs').writeFileSync(process.env.OAR_RESULT_PATH, 'Incomplete')"]))
    .rejects.toMatchObject({code: 1, stderr: expect.stringContaining('exact line FIM')});
});
