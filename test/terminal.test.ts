import {afterEach, expect, it} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalTerminalAdapter, cleanup} from '../src/terminal.js';

const directories: string[] = [];
afterEach(async () => {await Promise.all(directories.splice(0).map(path => rm(path, {recursive: true, force: true})));});
it('never closes running, foreign, or forged sessions; closes its own idle session', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'oar-terminal-'));
  directories.push(cwd);
  const adapter = new LocalTerminalAdapter();
  const handle = await adapter.start({owner: 'owned', cwd, input: '', env: {}, logPath: join(cwd, 'worker.log'),
    command: [process.execPath, '-e', 'setTimeout(() => {}, 150)']});
  expect(await adapter.isIdle(handle)).toBe(false);
  expect(await cleanup(adapter, 'owned', [handle])).toBe(0);
  await expect(adapter.close(handle)).rejects.toThrow('running');
  await expect(adapter.close({...handle})).rejects.toThrow('not owned');
  await expect(new LocalTerminalAdapter().close(handle)).rejects.toThrow('not owned');
  expect(await adapter.wait(handle)).toBe(0);
  expect(await cleanup(adapter, 'different owner', [handle])).toBe(0);
  expect(await adapter.isIdle(handle)).toBe(true);
  expect(await cleanup(adapter, 'owned', [handle])).toBe(1);
  await expect(adapter.isIdle(handle)).rejects.toThrow('not owned');
});
it('passes argv literally without invoking a shell', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'oar-argv-'));
  directories.push(cwd);
  const adapter = new LocalTerminalAdapter();
  const handle = await adapter.start({owner: 'owned', cwd, input: '', env: {}, logPath: join(cwd, 'worker.log'),
    command: [process.execPath, '-e', 'if (process.argv[1] !== "$(touch injected); echo nope") process.exit(2)', '$(touch injected); echo nope']});
  expect(await adapter.wait(handle)).toBe(0);
  expect(await cleanup(adapter, 'owned', [handle])).toBe(1);
});
