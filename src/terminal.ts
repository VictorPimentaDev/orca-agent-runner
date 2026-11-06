import {spawn} from 'node:child_process';
import {open} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

export interface TerminalRequest {
  owner: string;
  cwd: string;
  command: string[];
  input: string;
  env: Record<string, string>;
  logPath: string;
}
export interface TerminalHandle {id: string; owner: string}
export interface TerminalAdapter {
  start(request: TerminalRequest): Promise<TerminalHandle>;
  wait(handle: TerminalHandle): Promise<number>;
  isIdle(handle: TerminalHandle): Promise<boolean>;
  close(handle: TerminalHandle): Promise<void>;
}
interface Session {handle: TerminalHandle; idle: boolean; done: Promise<number>}

/** Local subprocesses only: no discovery of system terminals or persisted PIDs. */
export class LocalTerminalAdapter implements TerminalAdapter {
  private readonly sessions = new Map<string, Session>();

  async start(request: TerminalRequest): Promise<TerminalHandle> {
    const [executable, ...args] = request.command;
    if (!executable) throw new Error('A worker command is required');
    const log = await open(request.logPath, 'wx');
    const handle = Object.freeze({id: randomUUID(), owner: request.owner});
    let session: Session;
    const done = new Promise<number>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: request.cwd, env: {...process.env, ...request.env}, shell: false,
        stdio: ['pipe', log.fd, log.fd],
      });
      let failure: Error | undefined;
      child.on('error', error => {failure = error;});
      // An agent may intentionally ignore stdin and read OAR_SPEC_PATH instead.
      child.stdin?.on('error', error => {if (!('code' in error && error.code === 'EPIPE')) failure = error;});
      child.stdin?.end(request.input);
      child.on('close', code => {
        session.idle = true;
        if (failure) reject(failure);
        else resolve(code ?? 1);
      });
    });
    session = {handle, idle: false, done: done.finally(() => log.close())};
    // Keep rejection observed until the caller waits.
    void session.done.catch(() => undefined);
    this.sessions.set(handle.id, session);
    return handle;
  }

  private owned(handle: TerminalHandle): Session {
    const session = this.sessions.get(handle.id);
    if (!session || session.handle !== handle) throw new Error('Terminal is not owned by this adapter session');
    return session;
  }
  async wait(handle: TerminalHandle): Promise<number> {return this.owned(handle).done;}
  async isIdle(handle: TerminalHandle): Promise<boolean> {return this.owned(handle).idle;}
  async close(handle: TerminalHandle): Promise<void> {
    if (!this.owned(handle).idle) throw new Error('Refusing to close a running terminal');
    this.sessions.delete(handle.id);
  }
}

export async function cleanup(adapter: TerminalAdapter, owner: string, handles: TerminalHandle[]): Promise<number> {
  let closed = 0;
  for (const handle of handles) {
    if (handle.owner !== owner) continue;
    if (await adapter.isIdle(handle)) {await adapter.close(handle); closed++;}
  }
  return closed;
}
