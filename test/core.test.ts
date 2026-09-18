import * as fs from 'fs';
import * as path from 'path';
import { describe as suite, expect, it } from 'vitest';
import { describe, renderDescription } from '../src/core/describe';
import { diffGenerated } from '../src/core/diff';
import { applyEdits, readTextFile } from '../src/core/edit';
import { generateModel } from '../src/core/generate';
import { nodeView, treeLines } from '../src/core/json';
import { walk, XNode } from '../src/core/model';
import { decodeXml, encodeAttr, encodeText, parseText } from '../src/core/parser';
import { findProjects, globToRegExp, resolvePackage } from '../src/core/project';
import { allowedStepTypes, schemaFor, validateValue } from '../src/core/schema';
import { setValue } from '../src/core/ops';
import { Workspace } from '../src/core/workspace';
import { EXAMPLE, load, withCopy } from './helpers';

suite('parser', () => {
  it('records exact spans for attributes, fields and elements', () => {
    const file = path.join(EXAMPLE, 'Lights', 'LowBeam.pkg');
    const { text } = readTextFile(file);
    const idx = parseText(file, text);
    expect(idx.diagnostics).toEqual([]);
    let checked = 0;
    walk(idx.root!, (n) => {
      expect(text.slice(n.start, n.start + n.tag.length + 1)).toBe('<' + n.tag);
      expect(text[n.end - 1]).toBe('>');
      for (const a of n.attrs) expect(decodeXml(text.slice(a.span.start, a.span.end))).toBe(a.value);
      for (const f of n.fields) {
        expect(decodeXml(text.slice(f.span.start, f.span.end))).toBe(f.value);
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(50);
  });

  it('decodes and encodes XML entities', () => {
    const idx = parseText('x.pkg', '<A t="a&quot;b"><B>1 &lt; 2 &amp; &#65;&#x42;</B><C><![CDATA[<raw>]]></C></A>');
    expect(idx.root!.attrs[0].value).toBe('a"b');
    expect(idx.root!.fields.map((f) => f.value)).toEqual(['1 < 2 & AB', '<raw>']);
    expect(encodeText('a<b&c>')).toBe('a&lt;b&amp;c&gt;');
    expect(encodeAttr('say "hi"\n')).toBe('say &quot;hi&quot;&#10;');
  });

  it('handles CRLF and BOM files', () => {
    const crlf = readTextFile(path.join(EXAMPLE, 'Wipers', 'RainSensor.pkg'));
    expect(parseText('r.pkg', crlf.text).eol).toBe('\r\n');
    const bom = readTextFile(path.join(EXAMPLE, 'Lib', 'PowerOn.pkg'));
    expect(bom.bom).toBe(true);
    expect(bom.text.startsWith('<?xml')).toBe(true);
  });

  it('never throws on malformed input and reports file:line', () => {
    const idx = parseText('bad.pkg', '<PACKAGE>\n<VARIABLES>\n<VARIABLE><NAME>x</NAME>\n</VARIABLES>\n</WRONG>\n<TESTSTEPS');
    expect(idx.root?.tag).toBe('PACKAGE');
    expect(idx.diagnostics.map((d) => d.line)).toEqual(expect.arrayContaining([3, 5]));
    expect(parseText('empty.pkg', '').diagnostics[0].message).toMatch(/No XML root/);
    expect(parseText('junk.pkg', 'not xml at all <').diagnostics.length).toBeGreaterThan(0);
  });

  it('keeps unknown elements generically instead of dropping them', () => {
    const idx = parseText('u.pkg', '<PACKAGE><FUTURE-THING mode="x"><SETTING>1</SETTING></FUTURE-THING></PACKAGE>');
    const unknown = idx.root!.children[0];
    expect([unknown.kind, unknown.tag, unknown.attrs[0].value, unknown.fields[0].value]).toEqual(['element', 'FUTURE-THING', 'x', '1']);
  });

  it('round-trips every editable value: the edit changes that value and nothing else', async () => {
    await withCopy(EXAMPLE, (dir) => {
      const ws = load(dir);
      const targets = ws.all().filter((n) => n.valueRef && n.valueRef.type !== 'boolean');
      expect(targets.length).toBeGreaterThan(40);
      for (const node of targets) {
        const next = node.valueRef!.type === 'integer' ? '4711' : node.valueRef!.type === 'float' ? '47.11' : 'new <value> & "more"';
        const plan = setValue(ws, node.path, next);
        expect(plan.edits).toHaveLength(1);
        const before = ws.fileIndex(node).text;
        const after = applyEdits(before, plan.edits);
        const e = plan.edits[0];
        expect(after.slice(0, e.start)).toBe(before.slice(0, e.start));
        expect(after.slice(e.start + e.text.length)).toBe(before.slice(e.end));
        const reparsed = parseText(node.file, after);
        const same: XNode[] = [];
        walk(reparsed.root!, (n) => void (n.start === node.start && n.tag === node.tag && same.push(n)));
        expect(same[0].valueRef?.value ?? same[0].value).toBe(next);
        expect(reparsed.diagnostics).toEqual([]);
      }
    });
  });
});

suite('project discovery', () => {
  it('finds projects, honours ignore globs and the project filter', () => {
    expect(findProjects({ root: EXAMPLE }).map((f) => path.basename(f))).toEqual(['BodyControl.prj']);
    expect(findProjects({ root: EXAMPLE, project: 'nope' })).toEqual([]);
    expect(findProjects({ root: EXAMPLE, project: 'bodycontrol' })).toHaveLength(1);
    expect(globToRegExp('**/*.prj').test('a/b/c.prj')).toBe(true);
    expect(globToRegExp('**/node_modules/**').test('x/node_modules/y/z.prj')).toBe(true);
    expect(globToRegExp('*.prj').test('a/c.prj')).toBe(false);
  });

  it('resolves backslash, absolute foreign and base-dir references', () => {
    const prj = path.join(EXAMPLE, 'BodyControl.prj');
    const expected = path.join(EXAMPLE, 'Lights', 'LowBeam.pkg');
    expect(resolvePackage('Lights\\LowBeam.pkg', prj, { root: EXAMPLE })).toBe(expected);
    expect(resolvePackage('C:\\Work\\WS\\Packages\\Lights\\LowBeam.pkg', prj, { root: EXAMPLE })).toBe(expected);
    expect(resolvePackage('LowBeam.pkg', prj, { root: EXAMPLE })).toBeUndefined();
    expect(resolvePackage('LowBeam.pkg', prj, { root: EXAMPLE, packageBaseDirs: ['Lights'] })).toBe(expected);
  });

  it('reports the missing package as a diagnostic and keeps loading', () => {
    const ws = load(EXAMPLE);
    expect(ws.diagnostics).toHaveLength(1);
    expect(ws.diagnostics[0]).toMatchObject({ severity: 'error', path: '/BodyControl/Lights/FogLight', line: expect.any(Number) });
    expect(ws.diagnostics[0].message).toMatch(/Missing package "Lights\\FogLight.pkg"/);
    expect(ws.counts().packageRef).toBe(7);
  });

  it('loads packages that are only called, and several projects as separate roots', async () => {
    expect(load(EXAMPLE).resolve('/BodyControl/Lib/PowerOn').kind).toBe('package');
    await withCopy(EXAMPLE, (dir) => {
      fs.copyFileSync(path.join(dir, 'BodyControl.prj'), path.join(dir, 'Second.prj'));
      const ws = load(dir);
      expect(ws.roots().map((r) => r.path)).toEqual(['/BodyControl', '/Second']);
      expect(ws.resolve('/Second/Lights/LowBeam/settleTime').value).toBe('0.5');
      expect(Workspace.load({ root: dir, project: 'Second' }).roots().map((r) => r.path)).toEqual(['/Second']);
    });
  });
});

suite('addressing and search', () => {
  const ws = load(EXAMPLE);
  it('addresses packages below the project and elements by name', () => {
    expect(ws.resolve('/BodyControl').kind).toBe('project');
    expect(ws.resolve('/BodyControl/Lights').kind).toBe('folder');
    expect(ws.resolve('/BodyControl/Lights/LowBeam').kind).toBe('packageRef');
    expect(ws.resolve('/BodyControl/Lights/LowBeam/settleTime').label).toBe('parameter');
    expect(ws.resolve('/BodyControl/Lights/LowBeam/LightSwitch').kind).toBe('mapping');
    expect(ws.resolve('/BodyControl/Lights/LowBeam/Switch on/TsWait').value).toBe('settleTime');
    expect(ws.resolve('/bodycontrol/lights/lowbeam/switch ON').name).toBe('Switch on');
  });
  it('numbers duplicate names with #n', () => {
    const loop = '/BodyControl/Lights/HighBeam/Flash to pass/TsLoop';
    expect(ws.resolve(`${loop}/tsWrite HighBeamSwitch`).value).toBe('1');
    expect(ws.resolve(`${loop}/tsWrite HighBeamSwitch#2`).value).toBe('0');
  });
  it('explains unknown paths', () => {
    expect(() => ws.resolve('/BodyControl/Lights/LowBeam/nope')).toThrow(/Children of \/BodyControl\/Lights\/LowBeam: settleTime/);
    expect(() => ws.resolve('/Nope')).toThrow(/Known projects: \/BodyControl/);
  });
  it('searches names, values, types and fields and returns paths', () => {
    expect(ws.search('settleTime').map((n) => n.path)).toContain('/BodyControl/Lights/LowBeam/settleTime');
    expect(ws.search('LOW_BEAM_ON').map((n) => n.kind)).toContain('element');
    expect(ws.search('tsbreak')).toHaveLength(1);
    expect(ws.search('zzz-nothing')).toEqual([]);
  });
  it('renders tree lines and JSON views with file:line', () => {
    const lines = treeLines(ws.resolve('/BodyControl/Lights/LowBeam'), 1);
    expect(lines).toContain('  settleTime [parameter] = 0.5');
    const view = nodeView(ws, ws.resolve('/BodyControl/Lights/LowBeam/settleTime'), 0);
    expect(view).toMatchObject({ kind: 'parameter', value: '0.5', editable: true, source: expect.stringMatching(/^Lights\/LowBeam\.pkg:\d+$/) });
  });
});

suite('schema', () => {
  const ws = load(EXAMPLE);
  it('rejects bad values', () => {
    const int = ws.resolve('/BodyControl/Lights/HighBeam/flashCount').valueRef!;
    expect(validateValue(int, 'three')).toMatch(/not an integer/);
    expect(validateValue(int, '7')).toBeUndefined();
    expect(() => setValue(ws, '/BodyControl/Lights/LowBeam/settleTime', 'soon')).toThrow(/not a number/);
    expect(() => setValue(ws, '/BodyControl/Lights/LowBeam/@ENABLED', 'yes')).toThrow(/True or False/);
    expect(() => setValue(ws, '/BodyControl/Lights/LowBeam/Switch off/TsComment/@COMMENT-VERDICT', 'MAYBE')).toThrow(/allowed: NONE, SUCCESS/);
    expect(() => setValue(ws, '/BodyControl/Lights/LowBeam/Switch on/@xsi:type', 'x')).toThrow(/structural/);
  });
  it('knows what may be added where', () => {
    expect(allowedStepTypes(ws.resolve('/BodyControl/Lights/LowBeam'))).toContain('TsPrecondBlock');
    expect(allowedStepTypes(ws.resolve('/BodyControl/Lights/LowBeam/Switch on'))).not.toContain('TsBreak');
    expect(allowedStepTypes(ws.resolve('/BodyControl/Lights/Indicators/Left indicator/TsLoop'))).toContain('TsBreak');
    expect(allowedStepTypes(ws.resolve('/BodyControl/Lights/LowBeam/Switch on/TsWait'))).toEqual([]);
    expect(schemaFor(ws.resolve('/BodyControl')).operations).toEqual(expect.arrayContaining(['add-package']));
  });
});

suite('describe, generate preview and diff', () => {
  const ws = load(EXAMPLE);
  it('explains elements with references and generated functions', () => {
    const mapping = describe(ws, ws.resolve('/BodyControl/Lights/LowBeam/LightSwitch'));
    expect(mapping.what).toMatch(/bus signal/);
    expect(mapping.references.map((r) => r.path)).toContain('/BodyControl/Lights/LowBeam/Switch on/tsWrite LightSwitch');
    const block = renderDescription(describe(ws, ws.resolve('/BodyControl/Lights/LowBeam/Switch on')));
    expect(block).toMatch(/Becomes void TC_LowBeam_Switch_on\(void\)/);
    const lib = describe(ws, ws.resolve('/BodyControl/Lib/PowerOn'));
    expect(lib.references.some((r) => r.label === 'called by')).toBe(true);
    expect(renderDescription(describe(ws, ws.resolve('/BodyControl/Lights/FogLight')))).toMatch(/MISSING/);
  });
  it('previews one function per test case and skips disabled packages', () => {
    const all = generateModel(ws).map((c) => c.function);
    expect(all).toEqual(['TC_LowBeam_Switch_on', 'TC_LowBeam_Switch_off', 'TC_HighBeam_Permanent_high_beam', 'TC_HighBeam_Flash_to_pass', 'TC_Indicators_Left_indicator', 'TC_Indicators_Hazard', 'TC_WiperSpeed_main', 'TC_ReadDtc_Fault_memory_is_empty']);
    const one = generateModel(ws, ws.resolve('/BodyControl/Lights/Indicators/Left indicator'));
    expect(one).toHaveLength(1);
    expect(one[0].text).toContain('for (int i = 0; i < attempts; ++i) {');
    expect(one[0].text).toContain('break;');
    expect(generateModel(ws, ws.resolve('/BodyControl/Wipers/RainSensor'))).toEqual([]);
  });
  it('diffs the model against the generated folder', async () => {
    expect(diffGenerated(ws, 'gen').entries).toEqual([]);
    await withCopy(EXAMPLE, (dir) => {
      const copy = load(dir);
      copy.apply(setValue(copy, '/BodyControl/Lights/HighBeam/Permanent high beam/TsWait', '0.9'));
      fs.appendFileSync(path.join(dir, 'gen', 'test.h'), '\n/* @case /BodyControl/Gone/Old\n */\nvoid TC_Gone_Old(void)\n{\n}\n');
      const entries = diffGenerated(copy, 'gen').entries;
      expect(entries).toEqual([
        expect.objectContaining({ status: 'changed', function: 'TC_HighBeam_Permanent_high_beam', path: '/BodyControl/Lights/HighBeam/Permanent high beam' }),
        expect.objectContaining({ status: 'extra', function: 'TC_Gone_Old' }),
      ]);
      expect(diffGenerated(copy, 'no-such-dir').entries.every((e) => e.status === 'missing')).toBe(true);
    });
  });
});
