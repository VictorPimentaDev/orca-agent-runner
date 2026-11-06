import {afterEach, expect, it} from 'vitest';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configuration} from '../src/config.js';
const directories: string[] = [];
afterEach(async () => {await Promise.all(directories.splice(0).map(path => rm(path, {recursive: true, force: true})));});
it('applies flags > env > .oarrc > defaults and preserves argv', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'oar-config-'));
  directories.push(cwd);
  await writeFile(join(cwd, '.oarrc'), JSON.stringify({tasks: ['config'], command: ['config'], spec: 'config.md', dryRun: true}));
  const {config} = await configuration(['run', '--task', 'flag', '--spec', 'flag.md', '--', 'worker', '--flag', 'a b'],
    {OAR_TASKS: '["env"]', OAR_SPEC: 'env.md', OAR_STATE_DIR: '../state', OAR_DRY_RUN: 'false'}, cwd);
  expect(config.tasks).toEqual(['flag']);
  expect(config.spec).toBe(join(cwd, 'flag.md'));
  expect(config.command).toEqual(['worker', '--flag', 'a b']);
  expect(config.dryRun).toBe(false);
});
it.each([
  [{OAR_TASKS: '["../escape"]'}, 'Invalid task'],
  [{OAR_TASKS: '["x", "x"]'}, 'unique'],
  [{OAR_COMMAND: '"node"'}, 'array'],
  [{OAR_DRY_RUN: 'yes'}, 'true or false'],
])('rejects invalid environment config %j', async (env, message) => {
  const cwd = await mkdtemp(join(tmpdir(), 'oar-config-'));
  directories.push(cwd);
  await expect(configuration(['run'], env, cwd)).rejects.toThrow(message);
});
it('rejects malformed configs and explicit missing config paths', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'oar-config-'));
  directories.push(cwd);
  await expect(configuration(['run', '--config', 'missing.json'], {}, cwd)).rejects.toThrow('ENOENT');
  await writeFile(join(cwd, '.oarrc'), '{"typo":true}');
  await expect(configuration(['run'], {}, cwd)).rejects.toThrow('Unknown config field');
});
