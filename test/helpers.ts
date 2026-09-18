import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Workspace } from '../src/core/workspace';

export const REPO = path.resolve(__dirname, '..');
export const EXAMPLE = path.join(REPO, 'fixtures', 'example');
export const SAMPLES = path.join(REPO, 'samples');

/** Run `fn` against a throw-away copy of a folder; the copy is removed even when the test fails. */
export async function withCopy<T>(source: string, fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecutest-'));
  try {
    fs.cpSync(source, dir, { recursive: true });
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const load = (root: string) => Workspace.load({ root });

export function filesBelow(dir: string, ext: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesBelow(path.join(dir, e.name), ext) : ext.test(e.name) ? [path.join(dir, e.name)] : []));
}
