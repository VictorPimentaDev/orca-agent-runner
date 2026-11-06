import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {OrcaTerminalAdapter} from '../src/orca-terminal.js';
import {gestor} from '../src/runner.js';
import type {Config} from '../src/config.js';

// Real Orca only. Opt in with OAR_ORCA_SMOKE_WORKSPACE=path:/a/registered/workspace.
const workspace = process.env.OAR_ORCA_SMOKE_WORKSPACE;
const execute = promisify(execFile);

describe.skipIf(!workspace)('OrcaTerminalAdapter against a live Orca', () => {
  let base: string;
  let config: Config;
  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'oar-orca-smoke-')));
    const repo = join(base, 'repo');
    await mkdir(repo);
    await execute('git', ['init', '-q', repo]);
    await writeFile(join(repo, 'README.md'), '# Fixture\n');
    await execute('git', ['-C', repo, 'add', '.']);
    await execute('git', ['-C', repo, '-c', 'user.name=Test Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    const spec = join(base, 'SPEC.md');
    await writeFile(spec, 'Fixture spec.\n');
    config = {repo, spec, stateDir: join(base, 'state'), tasks: ['smoke'], dryRun: false,
      command: [process.execPath, resolve('examples/mock-worker.mjs')]};
  });
  afterAll(async () => {await rm(base, {recursive: true, force: true});});

  it('runs a worker in an owned terminal and closes only that terminal', async () => {
    const output = await gestor(config, new OrcaTerminalAdapter({workspace: workspace ?? ''}));
    expect(output.closed).toBe(1);
    expect(await readFile(output.workers[0]?.result ?? '', 'utf8')).toMatch(/FIM\n$/);
  }, 60_000);

  it('preserves a nonzero exit code that Orca itself reports as 0', async () => {
    const adapter = new OrcaTerminalAdapter({workspace: workspace ?? ''});
    const handle = await adapter.start({owner: 'smoke', cwd: base, input: '', env: {}, logPath: join(base, 'exit7.log'),
      command: [process.execPath, '-e', 'console.log("smoke-out"); process.exit(7)']});
    expect(await adapter.wait(handle)).toBe(7);
    expect(await readFile(join(base, 'exit7.log'), 'utf8')).toContain('smoke-out');
    expect(await adapter.isIdle(handle)).toBe(true);
    await adapter.close(handle);
  }, 60_000);
});
