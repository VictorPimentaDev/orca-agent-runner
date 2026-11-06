import {execFile} from 'node:child_process';
import {mkdtemp, open, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {TerminalAdapter, TerminalHandle, TerminalRequest} from './terminal.js';

const WAIT_CHUNK_MS = 30_000;
const CLI_GRACE_MS = 15_000;

/** Runs inside the Orca terminal. argv stays an array and SPEC/env stay off the visible command line. */
const ENTRYPOINT = `import {spawn} from 'node:child_process';
import {openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync} from 'node:fs';
const [sessionPath, receiptPath] = process.argv.slice(2);
const {command: [executable, ...args], cwd, env, input, logPath} = JSON.parse(readFileSync(sessionPath, 'utf8'));
rmSync(sessionPath);
const log = openSync(logPath, 'a');
const child = spawn(executable, args, {cwd, env: {...process.env, ...env}, shell: false, stdio: 'pipe'});
let error;
child.on('error', cause => {error ??= cause.message;});
child.stdin.on('error', cause => {if (cause.code !== 'EPIPE') error ??= cause.message;});
child.stdin.end(input);
process.stdout.on('error', () => undefined);
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', chunk => {writeSync(log, chunk); process.stdout.write(chunk);});
}
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('close', code => {
  writeFileSync(receiptPath + '.tmp', JSON.stringify({exitCode: code ?? 1, error}), {mode: 0o600});
  renameSync(receiptPath + '.tmp', receiptPath);
  process.exitCode = code ?? 1;
});
`;

export interface OrcaTerminalOptions {
  /** Orca worktree selector hosting the tab. Default `path:<request.cwd>`, which only matches a registered workspace. */
  workspace?: string;
  /** CLI executable. Default `orca`. */
  bin?: string;
}

interface OrcaTerminal {handle?: string; incarnationId?: string}
interface OrcaResult {terminal?: OrcaTerminal; wait?: {satisfied?: boolean}}
interface OrcaResponse {ok?: boolean; result?: OrcaResult; error?: {code?: string}}
interface Receipt {exitCode: number; error?: string}
interface Session {handle: TerminalHandle; incarnationId: string; directory: string}

class OrcaCliError extends Error {
  constructor(readonly code: string, command: string) {super(`orca terminal ${command} failed: ${code}`);}
}

function shellQuote(value: string): string {return `'${value.replaceAll(`'`, `'\\''`)}'`;}

function parseResponse(stdout: string): OrcaResponse | undefined {
  try {return JSON.parse(stdout) as OrcaResponse;} catch {return undefined;}
}

/**
 * Runs workers in Orca terminals through the sanctioned `orca terminal` CLI.
 * Holds handles it created in memory only: it never lists terminals, closes in
 * bulk, or adopts a handle from elsewhere.
 */
export class OrcaTerminalAdapter implements TerminalAdapter {
  private readonly sessions = new Map<string, Session>();
  private readonly bin: string;
  private readonly workspace: string | undefined;

  constructor(options: OrcaTerminalOptions = {}) {
    this.bin = options.bin ?? 'orca';
    this.workspace = options.workspace;
  }

  async start(request: TerminalRequest): Promise<TerminalHandle> {
    // ponytail: POSIX shells only; `--command` is typed into the host shell, so Windows needs its own quoting.
    if (process.platform === 'win32') throw new Error('OrcaTerminalAdapter supports macOS and Linux hosts only');
    if (!request.command[0]) throw new Error('A worker command is required');
    await (await open(request.logPath, 'wx', 0o600)).close();
    const directory = await mkdtemp(join(tmpdir(), 'oar-orca-'));
    try {
      const entrypoint = join(directory, 'entrypoint.mjs');
      const sessionPath = join(directory, 'session.json');
      await writeFile(entrypoint, ENTRYPOINT, {mode: 0o600});
      await writeFile(sessionPath, JSON.stringify({command: request.command, cwd: request.cwd,
        env: request.env, input: request.input, logPath: request.logPath}), {mode: 0o600});
      const launch = [process.execPath, entrypoint, sessionPath, join(directory, 'receipt.json')].map(shellQuote);
      const {terminal} = await this.orca(['create', '--worktree', this.workspace ?? `path:${request.cwd}`,
        '--title', `oar-${request.owner.slice(0, 8)}`, '--command', `exec ${launch.join(' ')}`]);
      if (!terminal?.handle || !terminal.incarnationId) throw new Error('orca terminal create returned no handle');
      const handle = Object.freeze({id: terminal.handle, owner: request.owner});
      this.sessions.set(handle.id, {handle, incarnationId: terminal.incarnationId, directory});
      return handle;
    } catch (error) {
      await rm(directory, {recursive: true, force: true});
      throw error;
    }
  }

  private owned(handle: TerminalHandle): Session {
    const session = this.sessions.get(handle.id);
    if (!session || session.handle !== handle) throw new Error('Terminal is not owned by this adapter session');
    return session;
  }

  private orca(args: string[], timeoutMs = 0): Promise<OrcaResult> {
    const [command = ''] = args;
    return new Promise((resolve, reject) => {
      execFile(this.bin, ['terminal', ...args, '--json'], {timeout: timeoutMs + CLI_GRACE_MS, maxBuffer: 4 * 1024 * 1024}, (error, stdout) => {
        const response = parseResponse(stdout);
        if (response?.ok && response.result) resolve(response.result);
        else if (response?.error?.code) reject(new OrcaCliError(response.error.code, command));
        else reject(error ?? new Error(`orca terminal ${command} returned an unreadable response`));
      });
    });
  }

  /** False only on Orca's explicit timeout. An outage or stale handle throws, so nothing gets closed on a guess. */
  private async exited(id: string, timeoutMs: number): Promise<boolean> {
    try {
      const {wait} = await this.orca(['wait', '--terminal', id, '--for', 'exit', '--timeout-ms', String(timeoutMs)], timeoutMs);
      if (wait?.satisfied !== true) throw new Error(`Orca could not confirm that terminal ${id} exited`);
      return true;
    } catch (error) {
      if (error instanceof OrcaCliError && error.code === 'timeout') return false;
      throw error;
    }
  }

  /** The code comes from the receipt: Orca 1.4.247 reported `exitCode: 0` for a process that exited with 7. */
  async wait(handle: TerminalHandle): Promise<number> {
    const {directory} = this.owned(handle);
    while (!await this.exited(handle.id, WAIT_CHUNK_MS));
    let receipt: Receipt;
    try {
      receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8')) as Receipt;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new Error(`Terminal ${handle.id} exited without a worker exit receipt`);
      }
      throw error;
    }
    if (receipt.error) throw new Error(receipt.error);
    return receipt.exitCode;
  }

  async isIdle(handle: TerminalHandle): Promise<boolean> {
    const session = this.owned(handle);
    const {terminal} = await this.orca(['show', '--terminal', handle.id]);
    if (terminal?.incarnationId !== session.incarnationId) {
      throw new Error(`Terminal ${handle.id} no longer matches the process this adapter started`);
    }
    return this.exited(handle.id, 1);
  }

  async close(handle: TerminalHandle): Promise<void> {
    const {directory} = this.owned(handle);
    if (!await this.isIdle(handle)) throw new Error('Refusing to close a running terminal');
    // `orca terminal close` kills a live PTY, so the idle check above is the only guard. No --tab: a user may have split this tab.
    await this.orca(['close', '--terminal', handle.id]);
    this.sessions.delete(handle.id);
    await rm(directory, {recursive: true, force: true});
  }
}
