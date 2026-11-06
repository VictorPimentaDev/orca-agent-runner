// A real local protocol run. The fixture does not implement a coding task.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = await mkdtemp(join(tmpdir(), 'oar-demo-'));
const repo = join(root, 'project');
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const fixture = fileURLToPath(new URL('./mock-worker.mjs', import.meta.url));
const run = (...args) => execFileSync(process.execPath, [cli, ...args], {encoding: 'utf8'});
try {
  console.log('$ npm run demo');
  console.log('LOCAL PROTOCOL DEMO / no AI provider or credentials');
  await mkdir(repo);
  await writeFile(join(repo, 'SPEC.md'), '# Demo\n\nExercise the worker completion protocol.\n');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'add', 'SPEC.md']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'initialize disposable demo']);
  console.log('1. Created a disposable, clean Git repository.');
  const spec = join(repo, 'SPEC.md');
  assert.match(run('intake', '--spec', spec), /completion protocol/);
  console.log('2. intake: SPEC.md read and validated.');
  const flags = ['--repo', repo, '--spec', spec, '--task', 'demo', '--state-dir', join(root, 'runs')];
  const plan = JSON.parse(run('run', ...flags, '--dry-run'));
  assert.equal(plan.workers.length, 0);
  console.log('3. dry-run: valid plan; zero workers started.');
  const output = JSON.parse(run('run', ...flags, '--', process.execPath, fixture));
  assert.equal(output.workers.length, 1);
  assert.equal(output.closed, 1);
  console.log('4. worker: one isolated worktree; local fixture exited 0.');
  const report = await readFile(output.workers[0].result, 'utf8');
  assert.match(report, /No implementation was performed/);
  assert.match(report, /\nFIM\n$/);
  console.log('5. result: nonempty report, final line FIM, copy preserved.');
  const manifest = JSON.parse(await readFile(join(output.runDir, 'run.json'), 'utf8'));
  assert.equal(manifest.status, 'completed');
  console.log('6. cleanup: 1 owned idle handle closed.');
  console.log('PASS / worktree + report + manifest checked');
  console.log('Fixture only. Plug in your own noninteractive coding agent.');
} finally {
  // Only the disposable directory created by this demo is removed.
  await rm(root, {recursive: true, force: true});
}
