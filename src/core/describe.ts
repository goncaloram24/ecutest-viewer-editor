// Plain-language explanation of an element: what it is in ECU-TEST, allowed values, which test.h function it
// becomes and where it is referenced.
import * as path from 'path';
import { attr, child, field, walk, XNode } from './model';
import { generateModel } from './generate';
import { allowedStepTypes, allowedValues, schemaFor, stepType } from './schema';
import { packageRootOf, Workspace } from './workspace';

export interface Description {
  path: string;
  title: string;
  what: string;
  details: string[];
  generated: string[];
  references: { label: string; path: string }[];
  source: string;
}

const XACCESS: Record<string, string> = {
  xaBusSignalVariable: 'a bus signal (bus / frame / PDU / signal)',
  xaModelValueVariable: 'a model variable',
  xaModelSignal: 'a model signal',
  xaServiceEventSignal: 'a service event signal',
  xaTraceFileSignal: 'a signal from a recorded trace file',
  aAServiceMethodParameter: 'a service method parameter',
};

const TAGS: Record<string, string> = {
  ACTION: 'Multi-language title of a block (one DVALUE per language).',
  CONDITION: 'Condition expression of an If step.',
  'LOOP-COUNT': 'How often the loop body is executed.',
  TIME: 'Wait time in seconds.',
  FORMULA: 'Formula of a calculation step.',
  EXPECTATION: 'Expected value of a read step; a mismatch fails the step.',
  'EXPECTATION-OPTION': 'Expected result of a calculation; a mismatch fails the step.',
  METRIC: 'Unit and representation (PHYS/RAW/TEXT) used for the mapped quantity.',
  'VARIABLE-REFS': 'Variables that receive the results of the step.',
  'PARAM-ASSIGNMENTS': 'Values passed to the parameters of the called package (one ASSIGNMENT per parameter).',
  'PACKAGE-REFERENCE': 'The package that is called.',
  'PACKAGE-REF': 'Reference from a project component to its package file.',
  XACCESS: 'Access definition of a mapping: what the mapping name points at in the test bench.',
  'TM-INFO': 'Test management information (IDs for ALM tools).',
  'PARAM-GENERATOR': 'Generates parameter variations for the package test case.',
  'DEFAULT-VALUE': 'Default value of a package variable.',
};

/** The addressable nodes whose XML (not nav children) mentions `name` as variable or mapping. */
function usages(node: XNode): XNode[] {
  const root = packageRootOf(node);
  const out = new Set<XNode>();
  if (!root) return [];
  walk(root, (n) => {
    const hit = n.fields.some((f) => f.value === node.name && (node.kind === 'mapping' ? f.tag === 'MAPPING-REF' : (f.tag === 'NAME' && n.type === 'varBaseExpression') || (f.tag === 'DVALUE' && n.tag === 'VARIABLE-NAME')));
    if (!hit) return;
    let owner: XNode | undefined = n;
    while (owner && owner.kind !== 'step') owner = owner.parent;
    if (owner?.path) out.add(owner);
  });
  return [...out];
}

function callers(ws: Workspace, file: string): XNode[] {
  const base = path.basename(file).toLowerCase();
  return ws.all().filter((n) => n.label === 'tsPackage' && path.basename((n.value ?? '').replace(/\\/g, '/')).toLowerCase() === base);
}

export function describe(ws: Workspace, node: XNode): Description {
  const rel = (f: string) => path.relative(ws.opts.root, f).replace(/\\/g, '/');
  const d: Description = { path: node.path, title: node.name, what: '', details: [], generated: [], references: [], source: `${rel(node.file)}:${node.line}` };
  const link = (label: string, n: XNode) => d.references.push({ label, path: n.path });
  const cases = generateModel(ws, node);
  const st = stepType(node.label);
  switch (node.kind) {
    case 'project': {
      const pkgs = ws.packagesOf(ws.projectOf(node));
      d.what = 'An ECU-TEST project (.prj): the ordered list of package test cases (optionally grouped in folders) that is executed as one test run.';
      d.details.push(`${pkgs.filter((p) => p.kind === 'packageRef').length} package test case(s), ${pkgs.filter((p) => p.kind === 'package').length} package(s) reached only through package calls.`);
      d.details.push('The path is derived from the file name; the display name is the field @NAME.');
      break;
    }
    case 'folder':
      d.what = 'A project folder (COMPONENT xsi:type="subproject"): groups package test cases. Disabling it (@ENABLED = False) skips everything inside.';
      break;
    case 'packageRef':
    case 'package': {
      const root = packageRootOf(node);
      d.what = node.kind === 'packageRef' ? `A package test case: the project executes the package ${node.ref?.raw}. Its parameters, mappings and test steps are the children of this element.` : 'A package (.pkg) that is not a test case of the project but is called by package-call steps.';
      if (!root) d.details.push(`The package file is MISSING: "${node.ref?.raw}" could not be resolved. Fix @PACKAGE-PATH on the PACKAGE-REF, add the file, or set packageBaseDirs.`);
      else {
        const info = child(root, 'INFORMATION');
        d.details.push(`File: ${rel(root.file)} (ECU-TEST ${attr(root, 'prog-version')?.value ?? 'unknown version'})`);
        const desc = info && field(info, 'DESCRIPTION')?.value;
        if (desc) d.details.push(`Description: ${desc}`);
        const params = node.navChildren.filter((c) => c.kind === 'parameter');
        if (params.length) d.details.push('Variables: ' + params.map((p) => `${p.name} (${p.label}${p.value ? ' = ' + p.value : ''})`).join(', '));
        for (const c of callers(ws, root.file)) link('called by', c);
        for (const other of ws.all()) if (other !== node && other.kind === 'packageRef' && other.ref?.resolved === root.file) link('also referenced as', other);
      }
      if (field(node, 'ENABLED')?.value === 'False') d.details.push('This test case is disabled (@ENABLED = False): no test.h function is generated.');
      break;
    }
    case 'parameter':
      d.what = { parameter: 'A package parameter (in="true"): callers and projects can pass a value; the default is used otherwise.', return: 'A package return value (out="true"): handed back to the caller of the package.', variable: 'A local package variable.' }[node.label ?? 'variable']!;
      d.details.push(node.valueRef ? `Default value: ${node.value} (type ${node.valueRef.type ?? 'string'}; new values must match this type)` : 'No literal default value (undefined/None). Setting a value creates one; the type is inferred (integer, float, boolean True/False, string).');
      usages(node).forEach((u) => link('used by', u));
      break;
    case 'mapping': {
      const xa = child(node, 'XACCESS');
      d.what = `A local mapping: the name "${node.name}" gives test steps access to ${XACCESS[node.label ?? ''] ?? `a test quantity (${node.label ?? 'unknown access type'})`}.`;
      if (xa) d.details.push('Target: ' + xa.fields.filter((f) => f.value).map((f) => `${f.tag}=${f.value}`).join(', '));
      usages(node).forEach((u) => link('used by', u));
      break;
    }
    case 'step': {
      d.title = `${st?.title ?? node.label} – ${node.name}`;
      d.what = st?.doc ?? `A test step of type ${node.label} that this tool shows generically (its fields and child elements are still editable).`;
      if (node.value !== undefined) d.details.push(`Value: ${node.value}${st?.valueDoc ? ` — ${st.valueDoc}` : ''}${node.valueRef ? '' : ' (composite expression; edit the child elements)'}`);
      const mapping = field(node, 'MAPPING-REF')?.value;
      const target = mapping && node.navParent && findUp(node, (n) => n.kind === 'packageRef' || n.kind === 'package')?.navChildren.find((c) => c.kind === 'mapping' && c.name === mapping);
      if (target) link('mapping', target);
      else if (mapping) d.details.push(`Mapping "${mapping}" is not defined in this package (global mapping).`);
      if (node.label === 'tsPackage') for (const p of ws.all()) if ((p.kind === 'packageRef' || p.kind === 'package') && packageRootOf(p) && path.basename(packageRootOf(p)!.file).toLowerCase() === path.basename((node.value ?? '').replace(/\\/g, '/')).toLowerCase()) link('calls', p);
      if (st) d.generated.push(`Generator: ${st.gen}`);
      break;
    }
    default:
      d.what = TAGS[node.tag] ?? `XML element <${node.tag}>${node.type ? ` (xsi:type="${node.type}")` : ''} shown generically: its fields and attributes can be edited, its structure is preserved as is.`;
      if (node.value !== undefined) d.details.push(`Value: ${node.value}`);
  }
  const schema = schemaFor(node);
  for (const f of schema.fields) d.details.push(`@${f.name} = ${f.value || '(empty)'} [${f.type}${f.allowed ? ': ' + f.allowed.join(' | ') : ''}]`);
  if (node.valueRef && allowedValues(node.valueRef)) d.details.push(`Allowed values: ${allowedValues(node.valueRef)!.join(', ')}`);
  const addable = allowedStepTypes(node);
  if (addable.length) d.details.push(`Can contain steps: ${addable.join(', ')}`);
  if (cases.length && node.kind !== 'project' && node.kind !== 'folder') d.generated.push(...cases.map((c) => `${c.path === node.path ? 'Becomes' : 'Part of'} void ${c.function}(void)`));
  else if (cases.length) d.generated.push(`${cases.length} test.h function(s): ${cases.slice(0, 12).map((c) => c.function).join(', ')}${cases.length > 12 ? ', …' : ''}`);
  for (const diag of ws.diagnostics) if (diag.path === node.path) d.details.push(`Problem: ${diag.message}`);
  return d;
}

function findUp(node: XNode, test: (n: XNode) => boolean): XNode | undefined {
  for (let n: XNode | undefined = node; n; n = n.navParent) if (test(n)) return n;
  return undefined;
}

export function renderDescription(d: Description): string {
  const lines = [`# ${d.title}`, `${d.path}  (${d.source})`, '', d.what];
  if (d.details.length) lines.push('', ...d.details.map((l) => `- ${l}`));
  if (d.generated.length) lines.push('', 'test.h:', ...d.generated.map((l) => `- ${l}`));
  if (d.references.length) lines.push('', 'References:', ...d.references.map((r) => `- ${r.label}: ${r.path}`));
  return lines.join('\n');
}
