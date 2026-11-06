import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {promisify} from 'node:util';
import {OrcaTerminalAdapter} from '../src/orca-terminal.js';
import {gestor} from '../src/runner.js';
import {cleanup, type TerminalRequest} from '../src/terminal.js';

const execute = promisify(execFile);
const bin = resolve('test/fixtures/fake-orca.mjs');
const previousTmp = process.env.TMPDIR;
let base: string;
let orcaDir: string;
let sessionsDir: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'oar-orca-test-'));
  orcaDir = join(base, 'orca');
  sessionsDir = join(base, "it's sessions"); // Apostrophe and space exercise the typed command's quoting.
  await mkdir(orcaDir);
  await mkdir(sessionsDir);
  process.env.FAKE_ORCA_DIR = orcaDir;
  process.env.TMPDIR = sessionsDir;
});
afterEach(async () => {
  if (previousTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmp;
  delete process.env.FAKE_ORCA_DIR;
  await rm(base, {recursive: true, force: true});
});

function request(script: string, overrides: Partial<TerminalRequest> = {}): TerminalRequest {
  return {owner: 'owner-1234', cwd: base, input: '', env: {}, logPath: join(base, `worker-${Math.random()}.log`),
    command: [process.execPath, '-e', script], ...overrides};
}
const calls = async (): Promise<string[][]> =>
  (await readFile(join(orcaDir, 'calls.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
const closeCalls = async (): Promise<string[][]> => (await calls()).filter(call => call[1] === 'close');

describe('OrcaTerminalAdapter', () => {
  it('keeps argv, SPEC and env literal and off the visible command, and reports the real exit code', async () => {
    const adapter = new OrcaTerminalAdapter({bin, workspace: 'path:/registered'});
    const hostile = `$(touch injected); echo 'nope'`;
    const log = join(base, 'worker.log');
    const handle = await adapter.start(request('', {command: [process.execPath, '-e', `
      let stdin = '';
      process.stdin.on('data', chunk => {stdin += chunk;}).on('end', () => {
        console.log(JSON.stringify({arg: process.argv[1], stdin, secret: process.env.OAR_TOKEN}));
        console.error('to stderr');
        process.exit(7);
      });`, hostile], input: 'the spec', env: {OAR_TOKEN: 'secret-value'}, logPath: log}));

    expect(await adapter.wait(handle)).toBe(7);
    const output = await readFile(log, 'utf8');
    expect(JSON.parse(output.split('\n')[0] ?? '')).toEqual({arg: hostile, stdin: 'the spec', secret: 'secret-value'});
    expect(output).toContain('to stderr');
    await expect(readdir(base)).resolves.not.toContain('injected');

    const typed = (await calls()).find(call => call[1] === 'create')?.join(' ');
    expect(typed).toContain('--worktree path:/registered');
    expect(typed).not.toContain('secret-value');
    expect(typed).not.toContain('the spec');
    expect(typed).not.toContain('touch injected');

    const [session] = await readdir(sessionsDir);
    expect(await readdir(join(sessionsDir, session ?? ''))).not.toContain('session.json');
    expect(await cleanup(adapter, 'owner-1234', [handle])).toBe(1);
    expect(await readdir(sessionsDir)).toEqual([]);
  });

  it('never closes busy, foreign or forged terminals, and never lists or closes in bulk', async () => {
    const adapter = new OrcaTerminalAdapter({bin, workspace: 'path:/registered'});
    const release = join(base, 'release');
    const handle = await adapter.start(request(`
      const {existsSync} = require('node:fs');
      setInterval(() => {if (existsSync(${JSON.stringify(release)})) process.exit(0);}, 10);`));

    expect(await adapter.isIdle(handle)).toBe(false);
    expect(await cleanup(adapter, 'owner-1234', [handle])).toBe(0);
    await expect(adapter.close(handle)).rejects.toThrow('running');
    await expect(adapter.close({...handle})).rejects.toThrow('not owned');
    await expect(adapter.close({id: 'term_0foreign', owner: 'owner-1234'})).rejects.toThrow('not owned');
    await expect(new OrcaTerminalAdapter({bin}).close(handle)).rejects.toThrow('not owned');
    expect(await closeCalls()).toEqual([]);

    await writeFile(release, '');
    expect(await adapter.wait(handle)).toBe(0);
    expect(await cleanup(adapter, 'someone-else', [handle])).toBe(0);
    expect(await closeCalls()).toEqual([]);
    expect(await cleanup(adapter, 'owner-1234', [handle])).toBe(1);
    expect(await closeCalls()).toEqual([['terminal', 'close', '--terminal', handle.id, '--json']]);
    await expect(adapter.isIdle(handle)).rejects.toThrow('not owned');

    for (const call of await calls()) {
      expect(['create', 'show', 'wait', 'close']).toContain(call[1]);
      expect(call).not.toContain('--all');
      expect(call).not.toContain('--tab');
    }
  });

  it.each([
    ['runtime-down', 'runtime_unavailable'],
    ['new-incarnation', 'no longer matches'],
  ])('keeps the terminal open when state cannot be verified: %s', async (fault, message) => {
    const adapter = new OrcaTerminalAdapter({bin, workspace: 'path:/registered'});
    const handle = await adapter.start(request('process.exit(0)'));
    expect(await adapter.wait(handle)).toBe(0);
    await writeFile(join(orcaDir, 'fault'), fault);
    await expect(adapter.isIdle(handle)).rejects.toThrow(message);
    await expect(adapter.close(handle)).rejects.toThrow(message);
    await expect(cleanup(adapter, 'owner-1234', [handle])).rejects.toThrow(message);
    expect(await closeCalls()).toEqual([]);
  });

  it('fails when the terminal dies without a receipt instead of trusting the reported exit code', async () => {
    const adapter = new OrcaTerminalAdapter({bin, workspace: 'path:/registered'});
    await writeFile(join(orcaDir, 'fault'), 'die-before-entrypoint');
    const handle = await adapter.start(request('process.exit(0)'));
    await expect(adapter.wait(handle)).rejects.toThrow('without a worker exit receipt');
  });

  it('reports a worker that cannot be spawned', async () => {
    const adapter = new OrcaTerminalAdapter({bin, workspace: 'path:/registered'});
    const handle = await adapter.start(request('', {command: [join(base, 'missing-executable')]}));
    await expect(adapter.wait(handle)).rejects.toThrow('ENOENT');
  });

  it('stops the worker when the terminal is hung up and records a failure', async () => {
    const adapter = new OrcaTerminalAdapter({bin, workspace: 'path:/registered'});
    const pids = join(base, 'pids');
    const handle = await adapter.start(request(`
      require('node:fs').writeFileSync(${JSON.stringify(pids)}, process.pid + ' ' + process.ppid);
      setInterval(() => {}, 1000);`));
    let content = '';
    while (!content) {
      await sleep(10);
      content = await readFile(pids, 'utf8').catch(() => '');
    }
    const [workerPid, entrypointPid] = content.split(' ').map(Number);
    process.kill(entrypointPid ?? 0, 'SIGHUP');
    expect(await adapter.wait(handle)).not.toBe(0);
    expect(() => process.kill(workerPid ?? 0, 0)).toThrow();
  });

  it('surfaces selector errors and leaves no session files behind', async () => {
    const adapter = new OrcaTerminalAdapter({bin});
    await expect(adapter.start(request('process.exit(0)', {cwd: join(base, 'unregistered')}))).rejects.toThrow('selector_not_found');
    expect(await readdir(sessionsDir)).toEqual([]);
    await expect(adapter.start(request('process.exit(0)', {command: []}))).rejects.toThrow('command is required');
  });

  it('runs a full gestor flow in an unregistered worktree through a registered host workspace', async () => {
    const repo = join(base, 'repo with spaces');
    await mkdir(repo);
    await execute('git', ['init', '-q', repo]);
    await writeFile(join(repo, 'README.md'), '# Fixture\n');
    await execute('git', ['-C', repo, 'add', '.']);
    await execute('git', ['-C', repo, '-c', 'user.name=Test Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    const spec = join(base, 'SPEC.md');
    await writeFile(spec, 'Fixture spec.\n');
    const output = await gestor({repo, spec, stateDir: join(base, 'state'), tasks: ['one', 'two'], dryRun: false,
      command: [process.execPath, resolve('examples/mock-worker.mjs')]}, new OrcaTerminalAdapter({bin, workspace: 'path:/registered'}));
    expect(output.closed).toBe(2);
    expect(output.workers.map(worker => worker.task)).toEqual(['one', 'two']);
    expect(await readFile(output.workers[0]?.result ?? '', 'utf8')).toMatch(/FIM\n$/);
    expect(await readdir(sessionsDir)).toEqual([]);
  }, 30_000);
});
