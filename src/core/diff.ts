// Compare the current model with an existing generated output folder (test.h files).
import * as fs from 'fs';
import * as path from 'path';
import { GenCase, generateModel } from './generate';
import { Workspace } from './workspace';

export interface DiffEntry {
  status: 'missing' | 'changed' | 'extra';
  function: string;
  /** Path of the block/package in the model ('' for extra functions whose source no longer exists). */
  path: string;
  detail: string;
}

export interface DiffResult {
  generatedDir: string;
  files: string[];
  same: number;
  entries: DiffEntry[];
}

const CASE = /\/\* @case ([^\n]*)\n[\s\S]*?\*\/\s*void\s+(\w+)\s*\(void\)\s*\{[\s\S]*?\n\}/g;
const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();

function firstDifference(a: string, b: string): string {
  const [x, y] = [normalize(a).split('\n'), normalize(b).split('\n')];
  const i = x.findIndex((l, n) => l !== y[n]);
  const at = i === -1 ? x.length : i;
  return `model: ${(x[at] ?? '(end)').trim()} | generated: ${(y[at] ?? '(end)').trim()}`;
}

export function diffGenerated(ws: Workspace, generatedDir: string): DiffResult {
  const dir = path.resolve(ws.opts.root, generatedDir);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.h$/i.test(f)).sort() : [];
  const generated = new Map<string, { text: string; path: string }>();
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of text.matchAll(CASE)) generated.set(m[2], { text: m[0], path: m[1].trim() });
  }
  const model = new Map<string, GenCase>(generateModel(ws).map((c) => [c.function, c]));
  const entries: DiffEntry[] = [];
  let same = 0;
  for (const c of model.values()) {
    const g = generated.get(c.function);
    if (!g) entries.push({ status: 'missing', function: c.function, path: c.path, detail: 'not in generated output; regenerate' });
    else if (normalize(g.text) !== normalize(c.text)) entries.push({ status: 'changed', function: c.function, path: c.path, detail: firstDifference(c.text, g.text) });
    else same++;
  }
  for (const [fn, g] of generated) {
    if (!model.has(fn)) entries.push({ status: 'extra', function: fn, path: ws.get(g.path)?.path ?? '', detail: `generated from ${g.path}, which no longer produces this function` });
  }
  return { generatedDir: dir, files, same, entries };
}
