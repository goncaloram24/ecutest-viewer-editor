import * as fs from 'fs';
import * as path from 'path';
import { describe as suite, expect, it } from 'vitest';
import { applyEdits, EditPlan } from '../src/core/edit';
import { addPackage, addParam, addStep, deleteNode, exprXml, moveNode, newProject, rename, setValue } from '../src/core/ops';
import { Workspace } from '../src/core/workspace';
import { EXAMPLE, load, withCopy } from './helpers';

const LOW = '/BodyControl/Lights/LowBeam';

/** Dry run must not touch the disk; applying must produce well-formed files with only the planned changes. */
function applyChecked(ws: Workspace, plan: EditPlan): void {
  const before = new Map(ws.files().map((f) => [f, fs.readFileSync(f, 'utf8')]));
  for (const [f, text] of before) expect(fs.readFileSync(f, 'utf8')).toBe(text);
  const expected = new Map<string, string>();
  for (const e of plan.edits) expected.set(e.file, applyEdits(before.get(e.file)!.replace(/^﻿/, ''), plan.edits.filter((x) => x.file === e.file)));
  ws.apply(plan);
  for (const [f, text] of expected) expect(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')).toBe(text);
  for (const [f, text] of before) if (!expected.has(f)) expect(fs.readFileSync(f, 'utf8')).toBe(text);
  expect(ws.diagnostics.filter((d) => !/Missing package/.test(d.message))).toEqual([]);
}

suite('ops', () => {
  it('set: values, fields, attributes, encoded text, undefined defaults', () =>
    withCopy(EXAMPLE, (dir) => {
      const ws = load(dir);
      const dry = setValue(ws, `${LOW}/settleTime`, '1.5');
      expect(dry.edits).toEqual([expect.objectContaining({ text: '1.5' })]);
      expect(dry.edits[0].end - dry.edits[0].start).toBe(3);
      applyChecked(ws, dry);
      expect(ws.resolve(`${LOW}/settleTime`).value).toBe('1.5');
      applyChecked(ws, setValue(ws, `${LOW}/Switch off/TsComment`, 'a < b & "c"'));
      expect(ws.resolve(`${LOW}/Switch off/TsComment`).value).toBe('a < b & "c"');
      expect(fs.readFileSync(path.join(dir, 'Lights/LowBeam.pkg'), 'utf8')).toContain('a &lt; b &amp; "c"');
      applyChecked(ws, setValue(ws, `${LOW}/@ENABLED`, 'False'));
      applyChecked(ws, setValue(ws, `${LOW}/@DESCRIPTION`, 'Changed description'));
      expect(fs.readFileSync(path.join(dir, 'Lights/LowBeam.pkg'), 'utf8')).toContain('>Changed description<');
      applyChecked(ws, setValue(ws, `${LOW}/verdict/@out`, 'false'));
      // CRLF file, variable with <DEFAULT-VALUE xsi:type="undefined"/>
      applyChecked(ws, setValue(ws, '/BodyControl/Wipers/RainSensor/undefinedStart', '12'));
      const rain = fs.readFileSync(path.join(dir, 'Wipers/RainSensor.pkg'), 'utf8');
      expect(rain).toContain('<DEFAULT-VALUE format-rev="1" xsi:type="value">\r\n\t\t\t\t<DATA xsi:type="integer">12</DATA>\r\n');
      expect(rain.replace(/\r\n/g, '')).not.toContain('\n');
      // BOM is preserved
      applyChecked(ws, setValue(ws, '/BodyControl/Lib/PowerOn/startupDelay', '3'));
      expect(fs.readFileSync(path.join(dir, 'Lib/PowerOn.pkg'), 'utf8').charCodeAt(0)).toBe(0xfeff);
      expect(() => setValue(ws, `${LOW}/Switch on`, 'x')).toThrow(/no directly editable value/);
      expect(() => setValue(ws, `${LOW}/@NOPE`, 'x')).toThrow(/no field or attribute/);
    }));

  it('reads and writes UTF-16 packages, and explains files that are found but unreadable', () =>
    withCopy(EXAMPLE, (dir) => {
      const dtc = path.join(dir, 'Diagnostics/ReadDtc.pkg');
      fs.writeFileSync(dtc, '\ufeff' + fs.readFileSync(dtc, 'utf8'), 'utf16le');
      fs.writeFileSync(path.join(dir, 'Lights/FogLight.pkg'), require('zlib').gzipSync('<PACKAGE/>'));
      fs.writeFileSync(path.join(dir, 'Lights/HighBeam.pkg'), '<SOMETHING-ELSE/>');
      const ws = load(dir);
      ws.apply(setValue(ws, '/BodyControl/Diagnostics/ReadDtc/dtcCount', '7'));
      expect(ws.resolve('/BodyControl/Diagnostics/ReadDtc/dtcCount').value).toBe('7');
      const bytes = fs.readFileSync(dtc);
      expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
      expect(bytes.toString('utf16le')).toContain('<DATA xsi:type="integer">7</DATA>');
      const messages = ws.diagnostics.map((d) => d.message).join('\n');
      expect(messages).toMatch(/"Lights\\FogLight.pkg" was found at Lights\/FogLight.pkg but cannot be shown: Cannot read FogLight.pkg: the file is gzip-compressed/);
      expect(messages).toMatch(/"Lights\\HighBeam.pkg" was found .* root element is <SOMETHING-ELSE>, expected <PACKAGE>/);
    }));

  it('add-step: every addable type, positions, indentation, empty containers', () =>
    withCopy(EXAMPLE, (dir) => {
      const ws = load(dir);
      const block = `${LOW}/Switch on`;
      const dry = addStep(ws, block, 'TsWait', { value: '2', after: `${block}/tsWrite LightSwitch` });
      expect(dry.edits[0].text).toMatch(/^\n\t\t\t<TESTSTEP id="[0-9a-f-]{36}" name="TsWait" xsi:type="utility-62d5a961/);
      applyChecked(ws, dry);
      expect(ws.resolve(block).navChildren.map((c) => c.name)).toEqual(['tsWrite LightSwitch', 'TsWait', 'TsWait', 'tsRead LowBeamLamp']);
      expect(ws.resolve(`${block}/TsWait`).value).toBe('2');
      applyChecked(ws, addStep(ws, block, 'comment', { value: 'first', before: `${block}/tsWrite LightSwitch` }));
      expect(ws.resolve(block).navChildren[0].value).toBe('first');
      applyChecked(ws, addStep(ws, LOW, 'TsBlock', { name: 'New case' }));
      applyChecked(ws, addStep(ws, `${LOW}/New case`, 'TsLoop', { value: '3' }));
      applyChecked(ws, addStep(ws, `${LOW}/New case/TsLoop`, 'TsIfThenElse', { value: 'lampState == 1' }));
      applyChecked(ws, addStep(ws, `${LOW}/New case/TsLoop/TsIfThenElse/THEN`, 'TsBreak'));
      applyChecked(ws, addStep(ws, `${LOW}/New case/TsLoop/TsIfThenElse/ELSE`, 'tsWrite', { name: 'LightSwitch', value: 'lampState' }));
      applyChecked(ws, addStep(ws, `${LOW}/New case`, 'TsCalculation', { name: 'lampState', value: 'lampState + 1' }));
      applyChecked(ws, addStep(ws, `${LOW}/New case`, 'tsRead', { name: 'LowBeamLamp' }));
      applyChecked(ws, addStep(ws, `${LOW}/New case`, 'tsPackage', { value: 'Lib\\PowerOn.pkg' }));
      expect(ws.resolve(`${LOW}/New case`).navChildren.map((c) => c.label)).toEqual(['TsLoop', 'TsCalculation', 'tsRead', 'tsPackage']);
      expect(ws.resolve(`${LOW}/New case/TsLoop/TsIfThenElse`).value).toBe('lampState == 1');
      expect(ws.resolve(`${LOW}/New case/TsCalculation`).value).toBe('lampState + 1');
      const text = fs.readFileSync(path.join(dir, 'Lights/LowBeam.pkg'), 'utf8');
      expect(text).toMatch(/\n\t{5}<THEN id="[^"]+" xsi:type="ifThenElseNode">\n\t{6}<TESTSTEP id="[^"]+" name="TsBreak" [^>]+\/>\n\t{5}<\/THEN>/);
      expect(() => addStep(ws, block, 'TsBreak')).toThrow(/not allowed/);
      expect(() => addStep(ws, `${block}/TsWait`, 'TsWait', { value: '1' })).toThrow(/cannot contain steps/);
      expect(() => addStep(ws, block, 'TsWait')).toThrow(/requires a value/);
      expect(() => addStep(ws, block, 'TsIfThenElse', { value: 'a == (b or c)' })).toThrow(/Unsupported expression/);
      expect(() => addStep(ws, '/BodyControl/Lights/FogLight', 'TsWait', { value: '1' })).toThrow(/not loaded/);
      expect(exprXml('X', '"text"')).toContain('<VALUE xsi:type="string">text</VALUE>');
    }));

  it('add-param: directions, duplicates, invalid names, empty VARIABLES section', () =>
    withCopy(EXAMPLE, (dir) => {
      const ws = load(dir);
      applyChecked(ws, addParam(ws, LOW, 'retries', '3'));
      applyChecked(ws, addParam(ws, LOW, 'label', 'front left', 'local'));
      expect(ws.resolve(`${LOW}/retries`)).toMatchObject({ label: 'parameter', value: '3' });
      expect(ws.resolve(`${LOW}/retries`).valueRef!.type).toBe('integer');
      expect(ws.resolve(`${LOW}/label`).label).toBe('variable');
      expect(() => addParam(ws, LOW, 'retries', '1')).toThrow(/already has/);
      expect(() => addParam(ws, LOW, '9lives', '1')).toThrow(/not a valid variable name/);
      expect(() => addParam(ws, `${LOW}/Switch on`, 'x', '1')).toThrow(/not a loaded package/);
      applyChecked(ws, addPackage(ws, '/BodyControl', 'New/Empty.pkg'));
      applyChecked(ws, addParam(ws, '/BodyControl/New/Empty', 'first', 'True', 'out'));
      expect(ws.resolve('/BodyControl/New/Empty/first').valueRef!.type).toBe('boolean');
    }));

  it('add-package and new-project create minimal valid files', () =>
    withCopy(EXAMPLE, (dir) => {
      const ws = load(dir);
      const dry = addPackage(ws, '/BodyControl/Wipers', 'Wipers/Washer.pkg', 'Washer pump');
      expect(dry.creates.map((c) => path.relative(dir, c.file))).toEqual([path.join('Wipers', 'Washer.pkg')]);
      expect(fs.existsSync(path.join(dir, 'Wipers/Washer.pkg'))).toBe(false);
      applyChecked(ws, dry);
      expect(ws.resolve('/BodyControl/Wipers/Washer')).toMatchObject({ kind: 'packageRef', name: 'Washer pump' });
      expect(ws.resolve('/BodyControl/Wipers').navChildren.map((c) => c.name)).toEqual(['Wiper speed', 'Rain sensor', 'Washer pump']);
      applyChecked(ws, addStep(ws, '/BodyControl/Wipers/Washer', 'TsWait', { value: '1' }));
      expect(ws.resolve('/BodyControl/Wipers/Washer/TsWait').value).toBe('1');
      expect(() => addPackage(ws, '/BodyControl', '/abs/evil.pkg')).toThrow(/relative to the project folder/);
      // The same package may be a test case several times; every reference shows its own copy of the contents.
      applyChecked(ws, addPackage(ws, '/BodyControl', 'Wipers/Washer.pkg', 'Washer again'));
      expect(ws.resolve('/BodyControl/Wipers/Washer#2/TsWait').value).toBe('1');
      applyChecked(ws, setValue(ws, '/BodyControl/Wipers/Washer#2/TsWait', '4'));
      expect(ws.resolve('/BodyControl/Wipers/Washer/TsWait').value).toBe('4');
      expect(() => addPackage(ws, LOW, 'X.pkg')).toThrow(/project or a folder/);
      // Referencing the existing, previously missing package file fixes the diagnostic.
      applyChecked(ws, newProject(ws, 'Smoke.prj'));
      expect(ws.roots().map((r) => r.path)).toEqual(['/BodyControl', '/Smoke']);
      const existing = addPackage(ws, '/Smoke', 'Diagnostics/ReadDtc.pkg');
      expect(existing.creates).toEqual([]);
      applyChecked(ws, existing);
      expect(ws.resolve('/Smoke/Diagnostics/ReadDtc/dtcCount').value).toBe('0');
      expect(() => newProject(ws, 'Smoke.prj')).toThrow(/already exists/);
    }));

  it('rename: block titles, parameters with references, mappings, test cases', () =>
    withCopy(EXAMPLE, (dir) => {
      const ws = load(dir);
      const dry = rename(ws, `${LOW}/settleTime`, 'settle_s');
      expect(dry.edits).toHaveLength(3);
      applyChecked(ws, dry);
      expect(ws.resolve(`${LOW}/Switch on/TsWait`).value).toBe('settle_s');
      applyChecked(ws, rename(ws, `${LOW}/LightSwitch`, 'Switch'));
      expect(ws.resolve(`${LOW}/Switch on/tsWrite Switch`).kind).toBe('step');
      applyChecked(ws, rename(ws, `${LOW}/Switch on`, 'Turn on'));
      expect(ws.resolve(`${LOW}/Turn on`).name).toBe('Turn on');
      applyChecked(ws, rename(ws, LOW, 'Dipped beam'));
      expect(ws.resolve(LOW).name).toBe('Dipped beam');
      applyChecked(ws, rename(ws, '/BodyControl/Lights', 'Exterior lights'));
      expect(() => rename(ws, `${LOW}/lampState`, 'settle_s')).toThrow(/already has/);
      expect(() => rename(ws, `${LOW}/lampState`, 'not valid')).toThrow(/not a valid variable name/);
      expect(() => rename(ws, `${LOW}/Turn on/TsWait`, 'x')).toThrow(/have no name/);
      expect(() => rename(ws, '/BodyControl', 'x')).toThrow(/named after its file/);
    }));

  it('delete: steps, parameters, package references (file kept)', () =>
    withCopy(EXAMPLE, (dir) => {
      const ws = load(dir);
      const lines = fs.readFileSync(path.join(dir, 'Lights/LowBeam.pkg'), 'utf8').split('\n').length;
      applyChecked(ws, deleteNode(ws, `${LOW}/Switch on/TsWait`));
      expect(fs.readFileSync(path.join(dir, 'Lights/LowBeam.pkg'), 'utf8').split('\n').length).toBe(lines - 5);
      expect(ws.get(`${LOW}/Switch on/TsWait`)).toBeUndefined();
      expect(deleteNode(ws, `${LOW}/settleTime`).summary).toMatch(/still referenced 1 time/);
      applyChecked(ws, deleteNode(ws, `${LOW}/Switch off`));
      applyChecked(ws, deleteNode(ws, '/BodyControl/Lights/FogLight'));
      expect(ws.diagnostics).toEqual([]);
      applyChecked(ws, deleteNode(ws, '/BodyControl/Diagnostics/ReadDtc'));
      expect(fs.existsSync(path.join(dir, 'Diagnostics/ReadDtc.pkg'))).toBe(true);
      expect(() => deleteNode(ws, '/BodyControl')).toThrow(/is a file/);
      expect(() => deleteNode(ws, '/BodyControl/Lights/Indicators/Hazard/TsIfThenElse/THEN')).toThrow(/belong to their If step/);
    }));

  it('move: reorder, re-parent with re-indentation, reject invalid targets', () =>
    withCopy(EXAMPLE, (dir) => {
      const ws = load(dir);
      applyChecked(ws, moveNode(ws, `${LOW}/Switch on`, { after: `${LOW}/Switch off` }));
      expect(ws.resolve(LOW).navChildren.filter((c) => c.kind === 'step').map((c) => c.name)).toEqual(['Ignition on', 'Switch off', 'Switch on', 'Ignition off']);
      applyChecked(ws, moveNode(ws, `${LOW}/verdict`, { before: `${LOW}/settleTime` }));
      expect(ws.resolve(LOW).navChildren[0].name).toBe('verdict');
      const ind = '/BodyControl/Lights/Indicators';
      applyChecked(ws, moveNode(ws, `${ind}/Left indicator/TsLoop/TsWait`, { after: `${ind}/Hazard/TsIfThenElse/THEN/TsComment` }));
      expect(ws.resolve(`${ind}/Hazard/TsIfThenElse/THEN/TsWait`).value).toBe('0.05');
      expect(fs.readFileSync(path.join(dir, 'Lights/Indicators.pkg'), 'utf8')).toMatch(/\n\t{5}<TESTSTEP id="[^"]+" name="TsWait"[^>]+>\n\t{6}<TIME /);
      applyChecked(ws, moveNode(ws, '/BodyControl/Diagnostics/ReadDtc', { before: '/BodyControl/Lights/LowBeam' }));
      expect(ws.resolve('/BodyControl/Lights').navChildren[0].path).toBe('/BodyControl/Diagnostics/ReadDtc');
      expect(() => moveNode(ws, `${LOW}/Switch on`, { after: `${LOW}/Switch on/tsWrite LightSwitch` })).toThrow(/into itself/);
      expect(() => moveNode(ws, `${LOW}/Switch on`, { after: `${LOW}/settleTime` })).toThrow(/not a compatible position/);
      expect(() => moveNode(ws, `${LOW}/Switch on`, {})).toThrow(/exactly one/);
    }));
});
