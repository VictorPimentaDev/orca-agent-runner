import {afterEach, expect, it} from 'vitest';
import {mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseResult, readResult, result} from '../src/result.js';

const directories: string[] = [];
afterEach(async () => {await Promise.all(directories.splice(0).map(path => rm(path, {recursive: true, force: true})));});
it.each(['# Done\nFIM', '# Done\nFIM\n', '# Done\r\nFIM\r\n'])('accepts an exact final marker: %j', text => {
  expect(parseResult(text)).toBe('# Done\nFIM\n');
});
it.each(['', 'FIM', '\nFIM\n', '# Done\n FIM', '# Done\nFIM ', '# Done\nFIM\nmore', '# Done\nFIM\n \n', '# Done\nFINAL'])('rejects incomplete or ambiguous result: %j', text => {
  expect(() => parseResult(text)).toThrow();
});
it('rejects result symlinks and refuses overwriting evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oar-result-'));
  directories.push(dir);
  const source = join(dir, 'source.md');
  const destination = join(dir, 'RESULT.md');
  const link = join(dir, 'link');
  await writeFile(source, '# Done\nFIM\n');
  await symlink(source, link);
  await expect(readResult(link)).rejects.toThrow('regular file');
  await result(source, destination);
  await expect(result(source, destination)).rejects.toThrow('EEXIST');
});
