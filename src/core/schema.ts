// What is allowed where. The rules were derived from real ECU-TEST 8.1 – 2026.2 packages/projects (see samples/)
// plus observation of the loaded workspace; they classify parsed elements and validate every edit.
import { attr, attrRef, child, field, Field, fieldRef, ValueRef, walk, XNode } from './model';

/** Tags that are always nodes, even when empty (<COMPONENTS/>, <TESTSTEP .../>), because edits target them. */
const STRUCTURAL = new Set(['PROJECT', 'PACKAGE', 'COMPONENTS', 'COMPONENT', 'TESTSTEPS', 'TESTSTEP', 'THEN', 'ELSE', 'VARIABLES', 'VARIABLE', 'MAPPING', 'MAPPING-ITEM']);
const SECTIONS = new Set(['COMPONENTS', 'TESTSTEPS', 'VARIABLES']);

export function isStructural(tag: string): boolean {
  return STRUCTURAL.has(tag);
}

export interface StepType {
  /** The label used everywhere: the `name` attribute of utility steps or the xsi:type of built-in steps. */
  label: string;
  xsiType: string;
  formatRev?: string;
  title: string;
  doc: string;
  /** May contain child steps. */
  container: boolean;
  /** Child element holding the step's main expression/value. */
  valueTag?: string[];
  valueDoc?: string;
  nameDoc?: string;
  /** How the dummy test.h generator renders the step. */
  gen: string;
  addable: boolean;
}

const U = (uuid: string) => `utility-${uuid}`;
const BLOCK = { container: true, nameDoc: 'block title (ACTION text)', addable: true };

export const STEP_TYPES: StepType[] = [
  { label: 'TsBlock', xsiType: U('2752ad1e-4fef-11dc-81d4-0013728784ee'), formatRev: '3', title: 'Block', doc: 'Groups test steps under a title. A top-level block of a package is one test case.', gen: 'top level: void TC_<package>_<block>(void); nested: a comment section', ...BLOCK },
  { label: 'TsPrecondBlock', xsiType: U('fd32d18b-c16d-45ca-9934-f8bffe11fcc3'), formatRev: '3', title: 'Precondition block', doc: 'Steps that establish the precondition; executed before every test case of the package.', gen: 'emitted at the start of every TC_ function of the package', ...BLOCK },
  { label: 'TsPostcondBlock', xsiType: U('0d2ac4dc-1d8f-4182-81d1-a5d5ca74a44f'), formatRev: '2', title: 'Postcondition block', doc: 'Clean-up steps; executed after every test case of the package, even on failure.', gen: 'emitted at the end of every TC_ function of the package', ...BLOCK },
  { label: 'TsComment', xsiType: U('1f4de951-4fef-11dc-969a-0013728784ee'), formatRev: '1', title: 'Comment', doc: 'Writes a comment (optionally with a verdict) into the report.', container: false, valueTag: ['COMMENT-EXPRESSION'], valueDoc: 'comment text', gen: 'a /* comment */ line', addable: true },
  { label: 'TsWait', xsiType: U('62d5a961-4fef-11dc-9944-0013728784ee'), title: 'Wait', doc: 'Pauses execution.', container: false, valueTag: ['TIME'], valueDoc: 'time in seconds (number or variable)', gen: 'TEST_WAIT(<seconds>);', addable: true },
  { label: 'TsLoop', xsiType: U('3da58cf0-4fef-11dc-be56-0013728784ee'), title: 'Loop', doc: 'Repeats its child steps.', container: true, valueTag: ['LOOP-COUNT'], valueDoc: 'loop count (integer or variable)', gen: 'for (...) { child steps }', addable: true },
  { label: 'TsBreak', xsiType: U('11b0144f-4e4f-11e0-b968-1c659df540cc'), title: 'Break', doc: 'Leaves the enclosing loop.', container: false, gen: 'break;', addable: true },
  { label: 'TsIfThenElse', xsiType: U('3609c41e-4fef-11dc-899a-0013728784ee'), title: 'If / Then / Else', doc: 'Conditional execution. Child steps live in the Then and Else branches.', container: false, valueTag: ['CONDITION'], valueDoc: 'condition, e.g. `speed > 10` or `mode == "PAD"`', gen: 'if (<condition>) { ... } else { ... }', addable: true },
  { label: 'THEN', xsiType: 'ifThenElseNode', title: 'Then branch', doc: 'Steps executed when the condition holds.', container: true, gen: 'the if-body', addable: false },
  { label: 'ELSE', xsiType: 'ifThenElseNode', title: 'Else branch', doc: 'Steps executed when the condition does not hold.', container: true, gen: 'the else-body', addable: false },
  { label: 'TsSwitchCase', xsiType: U('83517ac0-9f53-11dd-9c62-001b24fa84be'), title: 'Switch', doc: 'Selects one of its Case children by value.', container: false, valueTag: ['SWITCH-VALUE'], gen: 'switch (<value>) { ... }', addable: false },
  { label: 'caseNode', xsiType: 'caseNode', title: 'Case', doc: 'One branch of a switch.', container: true, valueTag: ['CASE-VALUE'], gen: 'case <value>:', addable: false },
  { label: 'TsCalculation', xsiType: U('4115fa00-5f3c-11df-8a53-001c233b3528'), formatRev: '3', title: 'Calculation', doc: 'Evaluates a formula; the result can be stored in a variable and checked against an expectation.', container: false, valueTag: ['FORMULA'], valueDoc: 'formula, e.g. `a + b`, `42`, `"text"`', nameDoc: 'variable that receives the result (optional)', gen: '<var> = <formula>;', addable: true },
  { label: 'tsRead', xsiType: 'tsRead', title: 'Read', doc: 'Reads a mapped quantity (bus signal, model variable, ...), optionally stores it in a variable and checks an expectation.', container: false, valueTag: ['MAPPING-REF'], valueDoc: 'mapping name', gen: 'TEST_READ(<mapping>);', addable: true },
  { label: 'tsWrite', xsiType: 'tsWrite', title: 'Write', doc: 'Writes a value to a mapped quantity.', container: false, valueTag: ['VALUE', 'DATA'], valueDoc: 'value to write (number, "string" or variable)', nameDoc: 'mapping name', gen: 'TEST_WRITE(<mapping>, <value>);', addable: true },
  { label: 'tsPackage', xsiType: 'tsPackage', formatRev: '2', title: 'Package call', doc: 'Calls another package, passing parameters and receiving return values.', container: false, valueTag: ['PACKAGE-REFERENCE'], valueDoc: 'package path relative to the Packages folder, e.g. `Lib\\Helper.pkg`', gen: 'PKG_<package>();', addable: true },
  { label: 'TsKeyword', xsiType: 'TsKeyword', title: 'Keyword', doc: 'Keyword-driven step bound to a keyword interface.', container: false, gen: 'a comment line', addable: false },
  { label: 'TsMultiCheck', xsiType: U('2fb63e30-6816-11e5-bfd3-4851b798ee63'), title: 'Multi check', doc: 'Checks several expectations at once.', container: true, gen: 'a comment line', addable: false },
];

export function stepType(label: string | undefined): StepType | undefined {
  const want = (label ?? '').toLowerCase().replace(/^ts/, '');
  return STEP_TYPES.find((t) => t.label.toLowerCase().replace(/^ts/, '') === want);
}

const ENUMS: Record<string, string[]> = {
  'COMMENT-VERDICT': ['NONE', 'SUCCESS', 'INCONCLUSIVE', 'FAILED', 'ERROR'],
  'VALUE-TYPE': ['PHYS', 'RAW', 'TEXT'],
  RELATION: ['==', '!=', '<', '<=', '>', '>='],
  style: ['relative', 'absolute'],
  in: ['true', 'false'],
  out: ['true', 'false'],
};
const READONLY_ATTRS = new Set(['xsi:type', 'format-rev', 'xmlns', 'xmlns:xsi', 'xsi:schemaLocation', 'prog-version', 'dkey']);

const BINARY: Record<string, string> = { BINARY_ADD: '+', BINARY_SUBTRACT: '-', BINARY_MULTIPLY: '*', BINARY_DIVIDE: '/', BINARY_TRUE_DIVIDE: '/', BINARY_MODULO: '%', BINARY_POWER: '**', BINARY_AND: '&', BINARY_OR: '|', BINARY_XOR: '^' };
const UNARY: Record<string, string> = { UNARY_NEGATIVE: '-', UNARY_INVERT: '~', UNARY_NOT: 'not ' };

function literal(f: Field): string {
  return attr(f, 'xsi:type')?.value === 'string' ? JSON.stringify(f.value) : f.value || 'None';
}

/** Render an expression element (FORMULA, CONDITION, TIME, ...) as readable text. */
export function exprText(holder: XNode | Field | undefined): string {
  if (!holder) return '';
  if (!('children' in holder)) return attr(holder, 'xsi:type')?.value?.endsWith('BaseExpression') ? 'None' : holder.value;
  const type = holder.type ?? '';
  const name = field(holder, 'NAME')?.value ?? '';
  const part = (tag: string) => exprText(child(holder, tag) ?? field(holder, tag));
  if (type === 'varBaseExpression') return name;
  if (type === 'binaryOpBaseExpression' && name === 'BINARY_SUBSCR') return `${part('FIRST-COMPONENT')}[${part('SECOND-COMPONENT')}]`;
  if (type === 'binaryOpBaseExpression' || type === 'compareOpBaseExpression') return `${part('FIRST-COMPONENT')} ${BINARY[name] ?? name} ${part('SECOND-COMPONENT')}`;
  if (type === 'unaryOpBaseExpression') return `${UNARY[name] ?? name + ' '}${exprText(holder.children[0] ?? holder.fields.find((f) => f.tag !== 'NAME'))}`;
  if (type === 'expressionValue') return part('DATA');
  if (type === 'functionBaseExpression') {
    const argHolder = child(holder, 'ARGUMENTS');
    const args = argHolder ? [...argHolder.children, ...argHolder.fields].sort((a, b) => ('element' in a ? a.element.start : a.start) - ('element' in b ? b.element.start : b.start)) : [];
    return `${part('COMPONENT')}(${args.map(exprText).join(', ')})`;
  }
  const value = field(holder, 'VALUE');
  if (value) return literal(value);
  const inner = child(holder, 'VALUE') ?? child(holder, 'DATA');
  return inner ? exprText(inner) : `<${type || holder.tag}>`;
}

/** The single editable leaf of an expression holder, if it is a plain literal or variable. */
function exprRef(holder: XNode | Field | undefined): ValueRef | undefined {
  if (!holder) return undefined;
  if (!('children' in holder)) return attr(holder, 'xsi:type')?.value?.endsWith('BaseExpression') ? undefined : fieldRef(holder);
  if (holder.children.length === 0) {
    const leaf = holder.type === 'varBaseExpression' ? field(holder, 'NAME') : field(holder, 'VALUE');
    return leaf && fieldRef(leaf);
  }
  return holder.type === 'expressionValue' ? exprRef(child(holder, 'DATA')) : undefined;
}

function descend(node: XNode, tags: string[]): XNode | Field | undefined {
  let cur: XNode | Field | undefined = node;
  for (const tag of tags) {
    if (!cur || !('children' in cur)) return undefined;
    const holder: XNode = cur;
    cur = child(holder, tag) ?? field(holder, tag);
  }
  return cur;
}

/** All DVALUE fields of an I18N ACTION element (one per language). */
function actionTexts(step: XNode): Field[] {
  const data = child(step, 'ACTION')?.children.find((c) => c.tag === 'MULTILANGDATA');
  return (data?.children ?? []).map((e) => field(e, 'DVALUE')).filter((f): f is Field => !!f);
}

/** Every text location that holds the node's name (a block title exists once per language). */
export function nameRefs(node: XNode): ValueRef[] {
  if (node.kind === 'step') {
    const shown = node.nameRef?.value;
    return actionTexts(node).filter((f) => f.value === shown).map(fieldRef);
  }
  // A project is addressed by its file name; its NAME field is only a display name (edit it as /@NAME).
  return node.nameRef && node.kind !== 'project' ? [node.nameRef] : [];
}

function classifyStep(n: XNode): void {
  n.kind = 'step';
  n.label = n.tag === 'TESTSTEP' ? attr(n, 'name')?.value || n.type || 'TESTSTEP' : n.tag;
  const st = stepType(n.label);
  n.name = n.label;
  const texts = actionTexts(n);
  const lang = field(child(n, 'ACTION') ?? n, 'INITIAL-LANGUAGE')?.value;
  const data = child(n, 'ACTION')?.children.find((c) => c.tag === 'MULTILANGDATA');
  const title = texts.find((f) => f.value && data?.children.some((e) => attr(e, 'dkey')?.value === lang && field(e, 'DVALUE') === f)) ?? texts.find((f) => f.value);
  if (title) {
    n.name = title.value;
    n.nameRef = fieldRef(title);
  }
  const holder = st?.valueTag && descend(n, st.valueTag);
  if (holder) {
    n.valueRef = exprRef(holder);
    n.value = n.valueRef?.value ?? exprText(holder);
  }
  const mapping = field(n, 'MAPPING-REF');
  if (mapping && (n.label === 'tsWrite' || n.label === 'tsRead')) n.name = `${n.label} ${mapping.value}`;
}

/** Assign kind, name, label and value references to every node of a parsed file. */
export function classify(root: XNode): void {
  walk(root, (n) => void (n.type = attr(n, 'xsi:type')?.value));
  const visit = (n: XNode) => {
    const nameField = field(n, 'NAME');
    if (n.tag === 'PROJECT' && !n.parent) n.kind = 'project';
    else if (n.tag === 'PACKAGE' && !n.parent) n.kind = 'package';
    else if (SECTIONS.has(n.tag) || (n.tag === 'MAPPING' && n.parent?.tag === 'PACKAGE')) n.kind = 'section';
    else if (n.tag === 'INFORMATION') n.kind = 'info';
    else if (n.tag === 'TESTSTEP' || ((n.tag === 'THEN' || n.tag === 'ELSE') && n.parent?.tag === 'TESTSTEP')) classifyStep(n);
    else if (n.tag === 'COMPONENT' && n.parent?.tag === 'COMPONENTS') {
      n.kind = n.type === 'packageTest' ? 'packageRef' : n.type === 'subproject' ? 'folder' : 'element';
      n.label = n.type;
      const refPath = field(child(n, 'PACKAGE-REF') ?? n, 'PACKAGE-PATH');
      if (n.kind === 'packageRef') n.ref = { raw: refPath?.value ?? '' };
    } else if (n.tag === 'VARIABLE') {
      n.kind = 'parameter';
      n.label = attr(n, 'in')?.value === 'true' ? 'parameter' : attr(n, 'out')?.value === 'true' ? 'return' : 'variable';
      const dv = child(n, 'DEFAULT-VALUE');
      const data = dv && (field(dv, 'DATA') ?? field(dv, 'OBJECT'));
      n.value = data ? data.value : '';
      n.valueRef = data && fieldRef(data);
    } else if (n.tag === 'MAPPING-ITEM') {
      n.kind = 'mapping';
      const xa = child(n, 'XACCESS');
      n.label = xa?.type;
      const target = xa && (field(xa, 'VARIABLE-PATH') ?? field(xa, 'SIGNAL-NAME') ?? xa.fields.find((f) => attr(f, 'xsi:type')?.value === 'string'));
      n.value = xa ? ['BUS-KEY', 'FRAME-NAME', 'PDU-NAME'].map((t) => field(xa, t)?.value).filter(Boolean).concat(target?.value ?? []).join('/') : '';
      n.valueRef = target && fieldRef(target);
      const id = field(n, 'ID');
      n.name = id?.value ?? '';
      n.nameRef = id && fieldRef(id);
    }
    if (n.kind !== 'step' && n.kind !== 'mapping') {
      const dkey = attr(n, 'dkey')?.value;
      const named = n.kind === 'folder' || n.kind === 'packageRef' || n.kind === 'parameter' || n.kind === 'project' || n.label !== undefined;
      n.name = named ? nameField?.value || n.tag : dkey ? `${n.tag}[${dkey}]` : n.tag;
      if (nameField && named) n.nameRef = fieldRef(nameField);
    }
    if (n.kind === 'element') {
      const text = exprText(n);
      n.valueRef = exprRef(n) ?? (n.fields.length === 1 && n.children.length === 0 ? fieldRef(n.fields[0]) : undefined);
      n.value = n.valueRef?.value ?? (text.startsWith('<') ? undefined : text);
    }
    n.children.forEach(visit);
  };
  visit(root);
}

/** Validate a new raw value for a value location. Returns an error message or undefined. */
export function validateValue(ref: ValueRef, value: string): string | undefined {
  const allowed = ENUMS[ref.tag];
  if (allowed && !allowed.includes(value)) return `"${value}" is not allowed for ${ref.tag}; allowed: ${allowed.join(', ')}`;
  if (ref.where === 'attr' && READONLY_ATTRS.has(ref.tag)) return `Attribute ${ref.tag} is structural and cannot be edited`;
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) return 'Value contains control characters that XML cannot represent';
  switch (ref.type) {
    case 'integer':
      return /^[+-]?\d+$/.test(value) ? undefined : `"${value}" is not an integer (xsi:type="integer")`;
    case 'float':
      return value.trim() !== '' && Number.isFinite(Number(value)) ? undefined : `"${value}" is not a number (xsi:type="float")`;
    case 'boolean':
      return value === 'True' || value === 'False' ? undefined : `"${value}" is not a boolean; use True or False`;
  }
  return undefined;
}

export function validateName(node: XNode, name: string): string | undefined {
  if (!name.trim()) return 'Name must not be empty';
  if (node.kind === 'parameter' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `"${name}" is not a valid variable name (letters, digits, underscore; must not start with a digit)`;
  return undefined;
}

/** ECU-TEST data type for a literal default value. */
export function inferType(value: string): 'integer' | 'float' | 'boolean' | 'string' {
  if (/^[+-]?\d+$/.test(value)) return 'integer';
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(value)) return 'float';
  return value === 'True' || value === 'False' ? 'boolean' : 'string';
}

/** Step type labels that may be added below `node`; empty if it is not a step container. */
export function allowedStepTypes(node: XNode): string[] {
  const container = node.kind === 'packageRef' || node.kind === 'package' || (node.kind === 'step' && stepType(node.label)?.container);
  if (!container) return [];
  const inLoop = (n: XNode | undefined): boolean => !!n && (n.label === 'TsLoop' || inLoop(n.navParent));
  return STEP_TYPES.filter((t) => t.addable && (t.label !== 'TsBreak' || inLoop(node)) && (!/cond/.test(t.label) || node.kind !== 'step')).map((t) => t.label);
}

export interface SchemaInfo {
  path: string;
  kind: string;
  type?: string;
  allowedChildren: { type: string; title: string; doc: string; name?: string; value?: string }[];
  operations: string[];
  value?: { type: string; allowed?: string[]; doc?: string; editable: boolean };
  fields: { name: string; type: string; allowed?: string[]; value: string }[];
  attributes: { name: string; value: string; editable: boolean; allowed?: string[] }[];
}

export function schemaFor(node: XNode): SchemaInfo {
  const st = node.kind === 'step' ? stepType(node.label) : undefined;
  const ops: string[] = [];
  if (node.valueRef) ops.push('set');
  if (node.fields.length || node.attrs.length) ops.push('set <path>/@<field|attribute>');
  if (nameRefs(node).length) ops.push('rename');
  if (allowedStepTypes(node).length) ops.push('add-step');
  if (node.kind === 'packageRef' || node.kind === 'package') ops.push('add-param');
  if (node.kind === 'project' || node.kind === 'folder') ops.push('add-package');
  if (node.kind !== 'project' && node.kind !== 'package' && node.tag !== 'THEN' && node.tag !== 'ELSE') ops.push('delete', 'move');
  const typeOf = (f: Field) => attr(f, 'xsi:type')?.value ?? 'string';
  return {
    path: node.path,
    kind: node.kind,
    type: node.label ?? node.type,
    allowedChildren: allowedStepTypes(node).map((label) => {
      const t = stepType(label)!;
      return { type: t.label, title: t.title, doc: t.doc, name: t.nameDoc, value: t.valueDoc };
    }),
    operations: ops,
    value: node.valueRef
      ? { type: node.valueRef.type ?? 'string', allowed: allowedValues(node.valueRef), doc: st?.valueDoc, editable: true }
      : node.value !== undefined
        ? { type: 'expression', doc: 'Composite expression: edit its parts through the child elements', editable: false }
        : undefined,
    fields: node.fields.map((f) => ({ name: f.tag, type: typeOf(f), allowed: allowedValues(fieldRef(f)), value: f.value })),
    attributes: node.attrs.map((a) => ({ name: a.name, value: a.value, editable: !READONLY_ATTRS.has(a.name), allowed: ENUMS[a.name] })),
  };
}

export function allowedValues(ref: ValueRef): string[] | undefined {
  return ENUMS[ref.tag] ?? (ref.type === 'boolean' ? ['True', 'False'] : undefined);
}

/** Resolve `@name` on a node: a field (leaf child element) first, then an attribute, then package information. */
export function memberRef(node: XNode, member: string): { ref: ValueRef; file: string } | undefined {
  const f = field(node, member);
  const a = attr(node, member);
  if (f || a) return { ref: f ? fieldRef(f) : attrRef(a!), file: node.file };
  const info = node.pkg && child(node.pkg, 'INFORMATION');
  const pf = info && field(info, member);
  return pf ? { ref: fieldRef(pf), file: info.file } : undefined;
}
