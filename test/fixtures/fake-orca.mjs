#!/usr/bin/env node
// Stand-in for `orca terminal`, shaped after responses observed from Orca 1.4.247.
// `wait` always reports exitCode 0, as the real CLI did for a process that exited with 7.
import {spawn} from 'node:child_process';
import {appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

const dir = process.env.FAKE_ORCA_DIR;
const args = process.argv.slice(2);
appendFileSync(join(dir, 'calls.log'), JSON.stringify(args) + '\n');
const flag = name => args[args.indexOf(name) + 1];
const fault = existsSync(join(dir, 'fault')) ? readFileSync(join(dir, 'fault'), 'utf8').trim() : '';
const reply = result => {console.log(JSON.stringify({ok: true, result}));};
const fail = code => {console.log(JSON.stringify({ok: false, error: {code}})); process.exit(1);};

if (args[0] !== 'terminal') fail('unsupported');
const id = flag('--terminal');
const done = join(dir, `${id}.done`);
if (['show', 'wait', 'close'].includes(args[1]) && !existsSync(join(dir, `${id}.term`))) fail('terminal_handle_stale');
switch (args[1]) {
  case 'create': {
    if (flag('--worktree').includes('unregistered')) fail('selector_not_found');
    const handle = `term_fake_${readdirSync(dir).filter(name => name.endsWith('.term')).length}`;
    writeFileSync(join(dir, `${handle}.term`), flag('--command'));
    const marker = join(dir, `${handle}.done`);
    if (fault === 'die-before-entrypoint') writeFileSync(marker, '');
    else spawn('/bin/sh', ['-c', `(${flag('--command')}); : > '${marker}'`], {detached: true, stdio: 'ignore'}).unref();
    reply({terminal: {handle, incarnationId: `inc-${handle}`}});
    break;
  }
  case 'show':
    if (fault === 'runtime-down') fail('runtime_unavailable');
    reply({terminal: {handle: id, incarnationId: fault === 'new-incarnation' ? 'inc-other' : `inc-${id}`}});
    break;
  case 'wait': {
    const deadline = Date.now() + Number(flag('--timeout-ms'));
    while (!existsSync(done)) {
      if (Date.now() >= deadline) fail('timeout');
      await sleep(10);
    }
    reply({wait: {handle: id, condition: 'exit', satisfied: true, status: 'exited', exitCode: 0}});
    break;
  }
  case 'close':
    reply({close: {handle: id, ptyKilled: true}});
    break;
  default:
    fail('unsupported');
}
