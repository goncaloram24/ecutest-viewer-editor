// Deterministically writes fixtures/example: one project, packages in sub folders, one missing reference.
// The XML mirrors real ECU-TEST files (see samples/): same elements, attribute order and tab indentation.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'example');
let counter = 0;
const id = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const hexId = () => String(++counter).padStart(32, '0');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nest = (lines) => lines.flat(Infinity).map((l) => '\t' + l);
const el = (open, children, tag = open.split(' ')[0]) => (children.length ? [`<${open}>`, ...nest(children), `</${tag}>`] : [`<${open}/>`]);

const U = {
  TsBlock: ['2752ad1e-4fef-11dc-81d4-0013728784ee', 3],
  TsPrecondBlock: ['fd32d18b-c16d-45ca-9934-f8bffe11fcc3', 3],
  TsPostcondBlock: ['0d2ac4dc-1d8f-4182-81d1-a5d5ca74a44f', 2],
  TsComment: ['1f4de951-4fef-11dc-969a-0013728784ee', 1],
  TsWait: ['62d5a961-4fef-11dc-9944-0013728784ee'],
  TsLoop: ['3da58cf0-4fef-11dc-be56-0013728784ee'],
  TsBreak: ['11b0144f-4e4f-11e0-b968-1c659df540cc'],
  TsIfThenElse: ['3609c41e-4fef-11dc-899a-0013728784ee'],
  TsCalculation: ['4115fa00-5f3c-11df-8a53-001c233b3528', 3],
};
const utility = (name, children) => el(`TESTSTEP${U[name][1] ? ` format-rev="${U[name][1]}"` : ''} id="${id()}" name="${name}" xsi:type="utility-${U[name][0]}"`, children, 'TESTSTEP');
const builtin = (type, children, rev) => el(`TESTSTEP${rev ? ` format-rev="${rev}"` : ''} id="${id()}" xsi:type="${type}"`, children, 'TESTSTEP');

// expressions
const lit = (tag, v) => {
  const type = typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'float') : 'string';
  return el(`${tag} format-rev="2" xsi:type="valueBaseExpression"`, [`<VALUE xsi:type="${type}">${esc(v)}</VALUE>`], tag);
};
const ref = (tag, name) => el(`${tag} xsi:type="varBaseExpression"`, [`<NAME xsi:type="string">${name}</NAME>`], tag);
const operand = (tag, v) => (typeof v === 'object' ? ref(tag, v.var) : lit(tag, v));
const op = (tag, kind, name, a, b) => el(`${tag} xsi:type="${kind}OpBaseExpression"`, [`<NAME xsi:type="string">${esc(name)}</NAME>`, operand('FIRST-COMPONENT', a), operand('SECOND-COMPONENT', b)], tag);
const v = (name) => ({ var: name });

// steps
const titled = (kind) => (title, ...steps) =>
  utility(kind, [el('ACTION xsi:type="I18NItem"', [el('MULTILANGDATA', [el('ELEMENT dkey="en_US"', [`<DVALUE xsi:type="string">${esc(title)}</DVALUE>`], 'ELEMENT')]), '<INITIAL-LANGUAGE xsi:type="string">en_US</INITIAL-LANGUAGE>'], 'ACTION'), ...steps]);
const block = titled('TsBlock');
const precondition = titled('TsPrecondBlock');
const postcondition = titled('TsPostcondBlock');
const comment = (text, verdict) => utility('TsComment', [lit('COMMENT-EXPRESSION', text), ...(verdict ? [`<COMMENT-VERDICT xsi:type="string">${verdict}</COMMENT-VERDICT>`] : [])]);
const wait = (seconds) => utility('TsWait', [operand('TIME', seconds)]);
const loop = (count, ...steps) => utility('TsLoop', [...steps, operand('LOOP-COUNT', count)]);
const brk = () => utility('TsBreak', []);
const ifThenElse = (cond, thenSteps, elseSteps = []) => utility('TsIfThenElse', [op('CONDITION', 'compare', ...cond), el(`THEN id="${id()}" xsi:type="ifThenElseNode"`, thenSteps, 'THEN'), el(`ELSE id="${id()}" xsi:type="ifThenElseNode"`, elseSteps, 'ELSE')]);
const varRefs = (name) => el('VARIABLE-REFS', [el('VARIABLE-NAME dkey="default"', [`<DVALUE xsi:type="string">${name}</DVALUE>`], 'VARIABLE-NAME')]);
const calc = (target, formula) => utility('TsCalculation', [varRefs(target), Array.isArray(formula) ? op('FORMULA', 'binary', ...formula) : operand('FORMULA', formula)]);
const metric = (valueType = 'PHYS') => el('METRIC format-rev="1" xsi:type="metricInfo"', ['<Z-UNIT xsi:type="string">u_none</Z-UNIT>', `<VALUE-TYPE xsi:type="string">${valueType}</VALUE-TYPE>`, '<DATA-TYPE xsi:type="string">VALUE</DATA-TYPE>']);
const write = (mapping, value) => builtin('tsWrite', [`<MAPPING-REF xsi:type="string">${mapping}</MAPPING-REF>`, el('VALUE xsi:type="expressionValue"', [operand('DATA', value)], 'VALUE'), metric()]);
const read = (mapping, into, expected) =>
  builtin('tsRead', [
    `<MAPPING-REF xsi:type="string">${mapping}</MAPPING-REF>`,
    ...(into ? [varRefs(into)] : []),
    ...(expected === undefined ? [] : [el('EXPECTATION xsi:type="timelessOption"', [el('EXPRESSION xsi:type="builtNumericExpression"', ['<RELATION xsi:type="string">==</RELATION>', operand('VALUE', expected)], 'EXPRESSION')], 'EXPECTATION')]),
    metric(),
  ]);
const call = (pkg, assignments = {}) =>
  builtin('tsPackage', [lit('PACKAGE-REFERENCE', pkg), el('PARAM-ASSIGNMENTS', Object.entries(assignments).map(([k, val]) => el(`ASSIGNMENT dkey="${k}"`, [operand('DVALUE', val)], 'ASSIGNMENT')))], 2);

// package parts
const variable = (name, value, dir, description) => {
  const type = typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'float') : 'string';
  return el(`VARIABLE format-rev="1"${dir ? ` ${dir}="true"` : ''} xsi:type="variable"`, [
    `<NAME xsi:type="string">${name}</NAME>`,
    ...(description ? [`<DESCRIPTION xsi:type="string">${esc(description)}</DESCRIPTION>`] : []),
    value === undefined ? '<DEFAULT-VALUE xsi:type="undefined"/>' : el('DEFAULT-VALUE format-rev="1" xsi:type="value"', [`<DATA xsi:type="${type}">${esc(value)}</DATA>`], 'DEFAULT-VALUE'),
  ], 'VARIABLE');
};
const busSignal = (name, frame, signal, description) =>
  el('MAPPING-ITEM format-rev="2" xsi:type="mappingItem"', [
    `<ID xsi:type="string">${name}</ID>`,
    ...(description ? [`<DESCRIPTION xsi:type="string">${esc(description)}</DESCRIPTION>`] : []),
    el('XACCESS format-rev="1" xsi:type="xaBusSignalVariable"', ['<MAPPING-ENUM xsi:type="vtabInfoEmpty"/>', '<BUS-KEY xsi:type="string">BODY_CAN</BUS-KEY>', `<FRAME-NAME xsi:type="string">${frame}</FRAME-NAME>`, `<SIGNAL-NAME xsi:type="string">${signal}</SIGNAL-NAME>`, `<PDU-NAME xsi:type="string">${frame}</PDU-NAME>`], 'XACCESS'),
    '<AUTO-GENERATED xsi:type="boolean">False</AUTO-GENERATED>',
  ], 'MAPPING-ITEM');
const modelVar = (name, variablePath) =>
  el('MAPPING-ITEM format-rev="2" xsi:type="mappingItem"', [`<ID xsi:type="string">${name}</ID>`, el('XACCESS format-rev="1" xsi:type="xaModelValueVariable"', [`<VARIABLE-PATH xsi:type="string">${variablePath}</VARIABLE-PATH>`], 'XACCESS'), '<AUTO-GENERATED xsi:type="boolean">False</AUTO-GENERATED>'], 'MAPPING-ITEM');

function pkg(file, { description, variables = [], mappings = [], steps = [] }, { crlf = false, bom = false } = {}) {
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    ...el('PACKAGE format-rev="7" prog-version="2024.1.0" xmlns="http://www.tracetronic.de/xml/ecu-test" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.tracetronic.de/xml/ecu-test package.xsd"', [
      el('INFORMATION format-rev="2" xsi:type="packageInfo"', [`<DESCRIPTION xsi:type="string">${esc(description)}</DESCRIPTION>`, '<VERSION xsi:type="string">1</VERSION>']),
      el('VARIABLES xsi:type="variableContainer"', variables),
      el('MAPPING format-rev="1" xsi:type="localMappingSpace"', mappings),
      el('TESTSTEPS xsi:type="testCase"', steps),
    ], 'PACKAGE'),
    '',
  ].flat(Infinity);
  const target = path.join(out, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, (bom ? String.fromCharCode(0xfeff) : '') + lines.join(crlf ? '\r\n' : '\n'), 'utf8');
}

const component = (type, name, extra, enabled = true) =>
  el(`COMPONENT format-rev="${type === 'subproject' ? 10 : 5}" xsi:type="${type}"`, [`<NAME xsi:type="string">${name}</NAME>`, `<ENABLED xsi:type="boolean">${enabled ? 'True' : 'False'}</ENABLED>`, '<REPORTING xsi:type="boolean">True</REPORTING>', `<ID xsi:type="string">${hexId()}</ID>`, ...extra], 'COMPONENT');
const folder = (name, ...components) => component('subproject', name, [el('COMPONENTS', components)]);
const testCase = (name, file, enabled) => component('packageTest', name, ['<COMPONENTS/>', el('PACKAGE-REF format-rev="1" style="relative" xsi:type="packageRef"', [`<PACKAGE-PATH xsi:type="string">${file}</PACKAGE-PATH>`], 'PACKAGE-REF')], enabled);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const ignition = busSignal('Ignition', 'BCM_STATUS', 'IGN_STATE', 'Terminal 15 state: 0 = off, 1 = on');

pkg('Lights/LowBeam.pkg', {
  description: 'Low beam follows the light switch while the ignition is on.',
  variables: [variable('settleTime', 0.5, 'in', 'Seconds to wait after each stimulus'), variable('lampState', 0), variable('verdict', 'NONE', 'out')],
  mappings: [ignition, busSignal('LightSwitch', 'LIGHT_CTRL', 'SWITCH_POS'), busSignal('LowBeamLamp', 'LIGHT_STATUS', 'LOW_BEAM_ON', 'Feedback of the low beam output <0|1>')],
  steps: [
    precondition('Ignition on', call('Lib\\PowerOn.pkg', { startupDelay: 1 })),
    block('Switch on', write('LightSwitch', 2), wait(v('settleTime')), read('LowBeamLamp', 'lampState', 1)),
    block('Switch off', write('LightSwitch', 0), wait(v('settleTime')), read('LowBeamLamp', 'lampState', 0), comment('Lamp is off & cold', 'SUCCESS')),
    postcondition('Ignition off', write('Ignition', 0)),
  ],
});

pkg('Lights/HighBeam.pkg', {
  description: 'High beam and flash-to-pass.',
  variables: [variable('flashCount', 3, 'in')],
  mappings: [busSignal('HighBeamSwitch', 'LIGHT_CTRL', 'HIGH_BEAM_REQ'), busSignal('HighBeamLamp', 'LIGHT_STATUS', 'HIGH_BEAM_ON')],
  steps: [
    block('Permanent high beam', write('HighBeamSwitch', 1), wait(0.2), read('HighBeamLamp', undefined, 1)),
    block('Flash to pass', loop(v('flashCount'), write('HighBeamSwitch', 1), wait(0.1), write('HighBeamSwitch', 0), wait(0.1))),
  ],
});

pkg('Lights/Indicators.pkg', {
  description: 'Direction indicators: waits for the first flash, then checks the hazard mode.',
  variables: [variable('attempts', 10, 'in'), variable('lamp', 0), variable('mode', 'LEFT', 'in')],
  mappings: [busSignal('IndicatorLever', 'LIGHT_CTRL', 'IND_LEVER'), busSignal('IndicatorLamp', 'LIGHT_STATUS', 'IND_LEFT_ON'), busSignal('HazardSwitch', 'LIGHT_CTRL', 'HAZARD')],
  steps: [
    block('Left indicator', write('IndicatorLever', 1), loop(v('attempts'), read('IndicatorLamp', 'lamp'), ifThenElse(['==', v('lamp'), 1], [brk()]), wait(0.05)), read('IndicatorLamp', undefined, 1)),
    block('Hazard', ifThenElse(['==', v('mode'), 'HAZARD'], [write('HazardSwitch', 1), comment('Hazard requested')], [comment('Hazard skipped', 'INCONCLUSIVE')])),
  ],
});

pkg('Wipers/WiperSpeed.pkg', {
  description: 'Wiper speed is derived from the stalk position.',
  variables: [variable('stalk', 2, 'in'), variable('expectedSpeed', 0), variable('speed', 0)],
  mappings: [busSignal('WiperStalk', 'WIPER_CTRL', 'STALK_POS'), modelVar('WiperMotorSpeed', 'Plant/Wiper/Motor/speed_rpm')],
  steps: [
    comment('Speed is 20 rpm per stalk position'),
    calc('expectedSpeed', ['BINARY_MULTIPLY', v('stalk'), 20]),
    write('WiperStalk', v('stalk')),
    wait(1),
    read('WiperMotorSpeed', 'speed'),
    ifThenElse(['>=', v('speed'), v('expectedSpeed')], [comment('Speed reached', 'SUCCESS')], [comment('Too slow', 'FAILED')]),
  ],
});

pkg('Wipers/RainSensor.pkg', {
  description: 'Automatic wiping when the rain sensor reports rain. (This file uses CRLF line endings.)',
  variables: [variable('rainLevel', 5, 'in'), variable('undefinedStart', undefined)],
  mappings: [modelVar('RainIntensity', 'Plant/Sensors/Rain/intensity'), modelVar('WiperActive', 'Plant/Wiper/active')],
  steps: [precondition('Power on', call('Lib\\PowerOn.pkg')), block('Rain detected', write('RainIntensity', v('rainLevel')), wait(2), read('WiperActive', undefined, 1)), block('Dry again', write('RainIntensity', 0), wait(5), read('WiperActive', undefined, 0))],
}, { crlf: true });

pkg('Lib/PowerOn.pkg', {
  description: 'Library package: switches the ignition on. Called by other packages, not a test case itself. (This file starts with a BOM.)',
  variables: [variable('startupDelay', 2, 'in', 'Seconds to wait for the ECUs to start')],
  mappings: [ignition],
  steps: [write('Ignition', 1), wait(v('startupDelay'))],
}, { bom: true });

pkg('Diagnostics/ReadDtc.pkg', {
  description: 'No fault memory entries after the light and wiper tests.',
  variables: [variable('dtcCount', 0)],
  mappings: [modelVar('DtcCount', 'Diag/BCM/dtc_count')],
  steps: [block('Fault memory is empty', read('DtcCount', 'dtcCount', 0))],
});

const prj = [
  '<?xml version="1.0" encoding="utf-8"?>',
  ...el('PROJECT format-rev="10" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"', [
    '<NAME xsi:type="string">Body control</NAME>',
    '<ENABLED xsi:type="boolean">True</ENABLED>',
    '<REPORTING xsi:type="boolean">True</REPORTING>',
    `<ID xsi:type="string">${hexId()}</ID>`,
    el('COMPONENTS', [
      folder('Lights', testCase('Low beam', 'Lights\\LowBeam.pkg'), testCase('High beam', 'Lights\\HighBeam.pkg'), testCase('Indicators', 'Lights\\Indicators.pkg'), testCase('Fog light', 'Lights\\FogLight.pkg')),
      folder('Wipers', testCase('Wiper speed', 'Wipers\\WiperSpeed.pkg'), testCase('Rain sensor', 'Wipers\\RainSensor.pkg', false)),
      testCase('Read DTC', 'Diagnostics\\ReadDtc.pkg'),
    ]),
  ], 'PROJECT'),
  '',
].flat(Infinity);
fs.writeFileSync(path.join(out, 'BodyControl.prj'), prj.join('\n'), 'utf8');

fs.writeFileSync(path.join(out, '.mcp.json'), JSON.stringify({ mcpServers: { ecutest: { command: 'node', args: ['../../dist/mcp.js', '--root', '.', '--generated-dir', 'gen'] } } }, null, 2) + '\n');
fs.writeFileSync(
  path.join(out, 'README.md'),
  `# Example project (generated)

Written by \`scripts/gen-example.mjs\`; do not edit by hand, run \`npm run gen-example\` instead.

- \`BodyControl.prj\` – project with two folders (Lights, Wipers) and one top-level test case.
- \`Lights/LowBeam.pkg\`, \`HighBeam.pkg\`, \`Indicators.pkg\` – blocks, pre/postcondition, loop, if/else, break, read/write/wait.
- \`Wipers/WiperSpeed.pkg\` – steps without blocks (one implicit \`main\` case), calculation.
- \`Wipers/RainSensor.pkg\` – disabled in the project, CRLF line endings, a variable without default value.
- \`Lib/PowerOn.pkg\` – only reached through package-call steps; starts with a BOM.
- \`Diagnostics/ReadDtc.pkg\` – smallest test case.
- \`Lights\\FogLight.pkg\` is referenced by the project but deliberately missing (diagnostics demo).
- \`gen/test.h\` – output of the dummy generator (\`node scripts/generate.mjs fixtures/example fixtures/example/gen\`).
- \`.mcp.json\` – MCP server configuration for agents opened in this folder.
`,
);
console.log(`wrote ${out}`);
