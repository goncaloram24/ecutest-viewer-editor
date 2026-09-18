// Real-world check against ECU-TEST files from public repositories (samples/, see SOURCES.md).
// Unlicensed samples are not committed: run `npm run fetch-samples` to download them; absent files are skipped.
import * as fs from 'fs';
import * as path from 'path';
import { describe as suite, expect, it } from 'vitest';
import { applyEdits, readTextFile } from '../src/core/edit';
import { generateModel } from '../src/core/generate';
import { walk } from '../src/core/model';
import { addPackage, addParam, addStep, deleteNode, newProject, setValue } from '../src/core/ops';
import { decodeXml, parseText } from '../src/core/parser';
import { filesBelow, load, SAMPLES, withCopy } from './helpers';

const files = filesBelow(SAMPLES, /\.(pkg|prj)$/i);
const acorn = path.join(SAMPLES, 'acorn50_EcuTestProject');

suite('real ECU-TEST samples', () => {
  it('indexes every sample with consistent offsets', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const { text, bom } = readTextFile(file);
      const idx = parseText(file, text, bom);
      if (/invalid/i.test(file)) expect(idx.diagnostics.length, file).toBeGreaterThan(0);
      else expect(idx.diagnostics, file).toEqual([]);
      expect(idx.root?.tag, file).toMatch(/^(PACKAGE|PROJECT)$/);
      walk(idx.root!, (n) => {
        expect(text.startsWith('<' + n.tag, n.start)).toBe(true);
        for (const f of n.fields) if (!f.cdata) expect(decodeXml(text.slice(f.span.start, f.span.end))).toBe(f.value);
        for (const a of n.attrs) expect(decodeXml(text.slice(a.span.start, a.span.end))).toBe(a.value);
      });
    }
  });

  it('references every sample package from a new project and edits them without collateral changes', () =>
    withCopy(SAMPLES, (dir) => {
      let ws = load(dir);
      ws.apply(newProject(ws, 'AllSamples.prj'));
      const pkgs = filesBelow(dir, /\.pkg$/i).filter((f) => !/invalid/i.test(f));
      for (const f of pkgs) ws.apply(addPackage(ws, '/AllSamples', path.relative(dir, f)));
      ws = load(dir);
      const all = ws.projects.find((p) => p.name === 'AllSamples')!;
      const refs = ws.packagesOf(all).filter((p) => p.kind === 'packageRef');
      expect(refs).toHaveLength(pkgs.length);
      expect(refs.every((r) => r.pkg)).toBe(true);
      expect(generateModel(ws, all.index.root).length).toBeGreaterThanOrEqual(pkgs.length);
      for (const ref of refs) {
        const file = ref.pkg!.file;
        const before = readTextFile(file).text;
        const plans = [addParam(ws, ref.path, 'zz_added_by_test', '42'), addStep(ws, ref.path, 'TsWait', { value: '1.5' })];
        const editable = ref.navChildren.find((c) => c.valueRef && (c.valueRef.type === 'string' || !c.valueRef.type) && c.valueRef.where === 'text');
        if (editable) plans.push(setValue(ws, editable.path, 'edited & <checked>'));
        const edits = plans.flatMap((p) => p.edits);
        const after = applyEdits(before, edits);
        expect(parseText(file, after).diagnostics, file).toEqual([]);
        // Removing exactly the inserted/changed text must give back the original: nothing else was touched.
        let restored = after;
        for (const e of [...edits].sort((a, b) => a.start - b.start)) restored = restored.slice(0, e.start) + before.slice(e.start, e.end) + restored.slice(e.start + e.text.length);
        expect(restored, file).toBe(before);
        ws.apply({ summary: 'combined', edits, creates: [] });
        expect(ws.resolve(`${ref.path}/zz_added_by_test`).value).toBe('42');
        ws.apply(deleteNode(ws, `${ref.path}/zz_added_by_test`));
      }
      expect(ws.diagnostics.filter((d) => !/Missing package/.test(d.message))).toEqual([]);
    }), 60000);

  it.skipIf(!fs.existsSync(acorn))('loads the ECU-TEST example workspace projects with all packages resolved', () => {
    const ws = load(acorn);
    expect(ws.projects.length).toBe(7);
    expect(ws.diagnostics).toEqual([]);
    expect(ws.resolve('/Calculate/Calculate/TsIfThenElse').value).toBe('summary is None');
    expect(ws.resolve('/Calculate/Summary').kind).toBe('package');
  });
});
