import {lstat, readFile, writeFile} from 'node:fs/promises';

export function parseResult(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const lines = normalized.split('\n');
  if (lines.at(-1) !== 'FIM') throw new Error('RESULT.md must end with the exact line FIM');
  if (!lines.slice(0, -1).join('\n').trim()) throw new Error('RESULT.md must describe the work before FIM');
  return `${normalized}\n`;
}

export async function readResult(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Result must be a regular file smaller than 1 MiB');
  return parseResult(await readFile(path, 'utf8'));
}

export async function result(source: string, destination: string): Promise<void> {
  await writeFile(destination, await readResult(source), {flag: 'wx', mode: 0o600});
}
