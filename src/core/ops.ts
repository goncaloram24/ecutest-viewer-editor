// High-level editing operations. Each one validates against the schema and returns an EditPlan of minimal
// text replacements; nothing is written here (see Workspace.apply / the extension's WorkspaceEdit).
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { EditPlan, TextEdit } from './edit';
import { attr, child, field, Field, FileIndex, Span, ValueRef, walk, XNode } from './model';
import { encodeAttr, encodeText } from './parser';
import { toPosix } from './project';
import { allowedStepTypes, inferType, memberRef, nameRefs, stepType, StepType, validateName, validateValue } from './schema';
import { packageRootOf, Workspace } from './workspace';

// ---------- text helpers ----------

function indentAt(text: string, offset: number): string {
  let s = offset;
  while (s > 0 && (text[s - 1] === ' ' || text[s - 1] === '\t')) s--;
  return text.slice(s, offset);
}

function indentUnit(text: string): string {
  const m = /\n([ \t]+)</.exec(text);
  return m ? m[1] : '\t';
}

/** Re-indent tab-indented template XML to the file's conventions. */
function render(xml: string, indent: string, idx: FileIndex): string {
  const unit = indentUnit(idx.text);
  return xml
    .split('\n')
    .map((l, i) => (i === 0 ? '' : indent) + l.replace(/^\t+/, (t) => unit.repeat(t.length)))
    .join(idx.eol);
}

/** Insert `xml` as a child of `container`: after `anchor` if given, else as first child. */
function insertChild(idx: FileIndex, container: XNode, xml: string, anchor?: Span, before?: Span): TextEdit {
  const { text, eol, file } = idx;
  const own = indentAt(text, container.start);
  const childIndent = own + indentUnit(text);
  if (before) {
    const ind = indentAt(text, before.start);
    return { file, start: before.start, end: before.start, text: render(xml, ind, idx) + eol + ind };
  }
  if (anchor) {
    const ind = indentAt(text, anchor.start);
    return { file, start: anchor.end, end: anchor.end, text: eol + ind + render(xml, ind, idx) };
  }
  const body = eol + childIndent + render(xml, childIndent, idx);
  if (container.selfClosing) {
    const open = text.slice(container.start, container.end).replace(/\s*\/>$/, '>');
    return { file, start: container.start, end: container.end, text: `${open}${body}${eol}${own}</${container.tag}>` };
  }
  const empty = !text.slice(container.inner.start, container.inner.end).includes('\n');
  return { file, start: container.inner.start, end: container.inner.start, text: empty ? body + eol + own : body };
}

/** Range of an element including the line break and indentation before it. */
function removalSpan(text: string, node: Span): Span {
  let s = node.start;
  while (s > 0 && (text[s - 1] === ' ' || text[s - 1] === '\t')) s--;
  if (text[s - 1] === '\n') s -= text[s - 2] === '\r' ? 2 : 1;
  else s = node.start;
  return { start: s, end: node.end };
}

function encodeFor(ref: ValueRef, value: string): string {
  if (ref.cdata) {
    if (value.includes(']]>')) throw new Error('Value must not contain "]]>" inside CDATA');
    return value;
  }
  return ref.where === 'attr' ? encodeAttr(value) : encodeText(value);
}

function valueEdit(idx: FileIndex, ref: ValueRef, value: string): TextEdit {
  if (ref.where !== 'empty') return { file: idx.file, start: ref.span.start, end: ref.span.end, text: encodeFor(ref, value) };
  const open = idx.text.slice(ref.span.start, ref.span.end).replace(/\s*\/>$/, '>');
  return { file: idx.file, start: ref.span.start, end: ref.span.end, text: value === '' ? idx.text.slice(ref.span.start, ref.span.end) : `${open}${encodeText(value)}</${ref.tag}>` };
}

function plan(summary: string, edits: TextEdit[], creates: EditPlan['creates'] = []): EditPlan {
  return { summary, edits: edits.filter((e) => e.start !== e.end || e.text !== ''), creates };
}

function idGenerator(root: XNode): () => string {
  let max = 0;
  let numeric = false;
  walk(root, (n) => {
    const id = attr(n, 'id')?.value;
    if (id && /^\d+$/.test(id)) {
      numeric = true;
      max = Math.max(max, Number(id));
    } else if (id) numeric = false;
  });
  return () => (numeric ? String(++max) : randomUUID());
}

// ---------- expression and step templates ----------

const BINARY_NAMES: Record<string, string> = { '+': 'BINARY_ADD', '-': 'BINARY_SUBTRACT', '*': 'BINARY_MULTIPLY', '/': 'BINARY_DIVIDE', '%': 'BINARY_MODULO' };
const OPERAND = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[+-]?\d+(?:\.\d+)?|[A-Za-z_][\w.]*`;

function operandXml(tag: string, src: string): string {
  if (/^["']/.test(src)) return `<${tag} format-rev="2" xsi:type="valueBaseExpression">\n\t<VALUE xsi:type="string">${encodeText(src.slice(1, -1))}</VALUE>\n</${tag}>`;
  if (src === 'None') return `<${tag} format-rev="2" xsi:type="valueBaseExpression"/>`;
  const type = inferType(src);
  if (type !== 'string') return `<${tag} format-rev="2" xsi:type="valueBaseExpression">\n\t<VALUE xsi:type="${type}">${src}</VALUE>\n</${tag}>`;
  return `<${tag} xsi:type="varBaseExpression">\n\t<NAME xsi:type="string">${encodeText(src)}</NAME>\n</${tag}>`;
}

/** XML for a simple expression: a literal, a variable, or `<operand> <operator> <operand>`. */
export function exprXml(tag: string, source: string): string {
  const src = source.trim();
  if (new RegExp(`^(?:${OPERAND})$`).test(src)) return operandXml(tag, src);
  const m = new RegExp(`^(${OPERAND})\\s*(==|!=|<=|>=|<|>|\\bis\\b|\\bin\\b|[-+*/%])\\s*(${OPERAND})$`).exec(src);
  if (!m) throw new Error(`Unsupported expression "${source}". Use a number, a "quoted string", a variable name, or <operand> <operator> <operand> with one of == != < <= > >= + - * / %`);
  const type = BINARY_NAMES[m[2]] ? 'binaryOpBaseExpression' : 'compareOpBaseExpression';
  const inner = [`<NAME xsi:type="string">${encodeText(BINARY_NAMES[m[2]] ?? m[2])}</NAME>`, operandXml('FIRST-COMPONENT', m[1]), operandXml('SECOND-COMPONENT', m[3])];
  return `<${tag} xsi:type="${type}">\n${inner.join('\n').replace(/^/gm, '\t')}\n</${tag}>`;
}

const nest = (xml: string) => xml.replace(/^/gm, '\t');
const stringExpr = (tag: string, v: string) => `<${tag} format-rev="2" xsi:type="valueBaseExpression">\n\t<VALUE xsi:type="string">${encodeText(v)}</VALUE>\n</${tag}>`;

export interface StepArgs {
  name?: string;
  value?: string;
}

function stepXml(t: StepType, args: StepArgs, newId: () => string): string {
  const need = (v: string | undefined, what: string) => {
    if (v === undefined || v === '') throw new Error(`${t.label} requires ${what}`);
    return v;
  };
  const body: string[] = [];
  switch (t.label) {
    case 'TsBlock':
    case 'TsPrecondBlock':
    case 'TsPostcondBlock':
      body.push(`<ACTION xsi:type="I18NItem">\n\t<MULTILANGDATA>\n\t\t<ELEMENT dkey="en_US">\n\t\t\t<DVALUE xsi:type="string">${encodeText(args.name ?? args.value ?? t.title)}</DVALUE>\n\t\t</ELEMENT>\n\t</MULTILANGDATA>\n\t<INITIAL-LANGUAGE xsi:type="string">en_US</INITIAL-LANGUAGE>\n</ACTION>`);
      break;
    case 'TsComment':
      body.push(stringExpr('COMMENT-EXPRESSION', need(args.value ?? args.name, 'a value (the comment text)')));
      break;
    case 'TsWait':
      body.push(exprXml('TIME', need(args.value, 'a value (seconds)')).replace('<TIME xsi', '<TIME format-rev="2" xsi'));
      break;
    case 'TsLoop':
      body.push(exprXml('LOOP-COUNT', need(args.value, 'a value (loop count)')));
      break;
    case 'TsIfThenElse':
      body.push(exprXml('CONDITION', need(args.value, 'a value (the condition)')), `<THEN id="${newId()}" xsi:type="ifThenElseNode"/>`, `<ELSE id="${newId()}" xsi:type="ifThenElseNode"/>`);
      break;
    case 'TsCalculation':
      if (args.name) body.push(`<VARIABLE-REFS>\n\t<VARIABLE-NAME dkey="default">\n\t\t<DVALUE xsi:type="string">${encodeText(args.name)}</DVALUE>\n\t</VARIABLE-NAME>\n</VARIABLE-REFS>`);
      body.push(exprXml('FORMULA', need(args.value, 'a value (the formula)')));
      break;
    case 'tsRead':
      body.push(`<MAPPING-REF xsi:type="string">${encodeText(need(args.name ?? args.value, 'a mapping name'))}</MAPPING-REF>`);
      break;
    case 'tsWrite':
      body.push(`<MAPPING-REF xsi:type="string">${encodeText(need(args.name, 'a name (the mapping)'))}</MAPPING-REF>`, `<VALUE xsi:type="expressionValue">\n${nest(exprXml('DATA', need(args.value, 'a value to write')))}\n</VALUE>`);
      break;
    case 'tsPackage':
      body.push(stringExpr('PACKAGE-REFERENCE', need(args.value ?? args.name, 'a value (package path)')));
      break;
  }
  const utility = t.xsiType.startsWith('utility-');
  const open = `<TESTSTEP${t.formatRev ? ` format-rev="${t.formatRev}"` : ''} id="${newId()}"${utility ? ` name="${t.label}"` : ''} xsi:type="${t.xsiType}"`;
  return body.length ? `${open}>\n${nest(body.join('\n'))}\n</TESTSTEP>` : `${open}/>`;
}

// ---------- operations ----------

function splitMember(p: string): { nodePath: string; member?: string } {
  const m = /^(.*)\/@([^/]+)$/.exec(p.trim());
  return m ? { nodePath: m[1], member: m[2] } : { nodePath: p };
}

export function setValue(ws: Workspace, target: string, value: string): EditPlan {
  const { nodePath, member } = splitMember(target);
  const node = ws.resolve(nodePath);
  if (member) {
    const found = memberRef(node, member);
    if (!found) throw new Error(`${node.path} has no field or attribute "${member}". Fields: ${node.fields.map((f) => f.tag).join(', ') || '-'}; attributes: ${node.attrs.map((a) => a.name).join(', ') || '-'}`);
    const bad = validateValue(found.ref, value);
    if (bad) throw new Error(bad);
    const idx = found.file === node.file ? ws.fileIndex(node) : ws.fileIndex(node.pkg!);
    return plan(`set ${node.path}/@${member} = ${value}`, [valueEdit(idx, found.ref, value)]);
  }
  const idx = ws.fileIndex(node);
  if (!node.valueRef) {
    if (node.kind === 'parameter') return plan(`set ${node.path} = ${value}`, [defaultValueEdit(idx, node, value)]);
    throw new Error(`${node.path} (${node.label ?? node.kind}) has no directly editable value${node.value !== undefined ? ` (its value "${node.value}" is a composite expression; edit its child elements)` : ''}. Use get/schema to see editable fields and address them as <path>/@FIELD.`);
  }
  const bad = validateValue(node.valueRef, value);
  if (bad) throw new Error(bad);
  const edits = [valueEdit(idx, node.valueRef, value)];
  const textData = node.kind === 'parameter' && field(child(node, 'DEFAULT-VALUE')!, 'TEXTDATA');
  if (textData) edits.push({ file: idx.file, start: textData.span.start, end: textData.span.end, text: encodeText(value) });
  return plan(`set ${node.path} = ${value}`, edits);
}

function defaultValueXml(value: string, withTextData: boolean): string {
  const lines = [`<DATA xsi:type="${inferType(value)}">${encodeText(value)}</DATA>`];
  if (withTextData) lines.push(`<TEXTDATA xsi:type="string">${encodeText(value)}</TEXTDATA>`);
  return `<DEFAULT-VALUE format-rev="1" xsi:type="value">\n${nest(lines.join('\n'))}\n</DEFAULT-VALUE>`;
}

function usesTextData(root: XNode): boolean {
  let found = false;
  walk(root, (n) => void (found ||= n.tag === 'DEFAULT-VALUE' && !!field(n, 'TEXTDATA')));
  return found;
}

/** Give a variable without a literal default (undefined / None) a value element. */
function defaultValueEdit(idx: FileIndex, variable: XNode, value: string): TextEdit {
  const xml = defaultValueXml(value, usesTextData(idx.root!));
  const old = field(variable, 'DEFAULT-VALUE')?.element ?? child(variable, 'DEFAULT-VALUE');
  if (old) return { file: idx.file, start: old.start, end: old.end, text: render(xml, indentAt(idx.text, old.start), idx) };
  return insertChild(idx, variable, xml, variable.fields[variable.fields.length - 1]?.element);
}

export function addStep(ws: Workspace, parentPath: string, type: string, args: StepArgs & { after?: string; before?: string } = {}): EditPlan {
  const parent = ws.resolve(parentPath);
  const t = stepType(type);
  const allowed = allowedStepTypes(parent);
  if (!allowed.length) throw new Error(`${parent.path} (${parent.label ?? parent.kind}) cannot contain steps. Containers: packages, blocks, loops, Then/Else branches, cases.`);
  if (!t || !allowed.includes(t.label)) throw new Error(`Step type "${type}" is not allowed in ${parent.path}. Allowed: ${allowed.join(', ')}`);
  const pkgRoot = packageRootOf(parent);
  if (!pkgRoot) throw new Error(`Package of ${parent.path} is not loaded (missing file?)`);
  const idx = ws.fileIndex(pkgRoot);
  const container = parent.kind === 'step' ? parent : child(pkgRoot, 'TESTSTEPS');
  const xml = stepXml(t, args, idGenerator(pkgRoot));
  const sibling = (p: string | undefined) => {
    if (!p) return undefined;
    const n = ws.resolve(p);
    if (n.kind !== 'step' || n.navParent !== parent) throw new Error(`${n.path} is not a step directly inside ${parent.path}`);
    return n;
  };
  const after = sibling(args.after);
  const before = sibling(args.before);
  if (!container) {
    const last = pkgRoot.children[pkgRoot.children.length - 1];
    return plan(`add ${t.label} to ${parent.path}`, [insertChild(idx, pkgRoot, `<TESTSTEPS xsi:type="testCase">\n${nest(xml)}\n</TESTSTEPS>`, last)]);
  }
  // Without an explicit position: after the last step, else after the block title (ACTION).
  const steps = container.children.filter((c) => c.kind === 'step');
  const anchor = after ?? steps.at(-1) ?? container.children.filter((c) => c.tag === 'ACTION' || c.tag === 'ABORT-CONDITION').at(-1);
  return plan(`add ${t.label} to ${parent.path}`, [insertChild(idx, container, xml, before ? undefined : anchor, before)]);
}

export function addParam(ws: Workspace, packagePath: string, name: string, value: string, direction: 'in' | 'out' | 'local' = 'in'): EditPlan {
  const node = ws.resolve(packagePath);
  const pkgRoot = node.kind === 'packageRef' || node.kind === 'package' ? packageRootOf(node) : undefined;
  if (!pkgRoot) throw new Error(`${node.path} is not a loaded package; add-param needs a package path like /<project>/<package>`);
  const idx = ws.fileIndex(pkgRoot);
  const section = child(pkgRoot, 'VARIABLES');
  const existing = section?.children.filter((c) => c.kind === 'parameter') ?? [];
  const bad = validateName({ kind: 'parameter' } as XNode, name);
  if (bad) throw new Error(bad);
  if (existing.some((v) => v.name === name)) throw new Error(`Package already has a variable named "${name}"`);
  const dir = direction === 'local' ? '' : ` ${direction}="true"`;
  const xml = `<VARIABLE format-rev="1"${dir} xsi:type="variable">\n\t<NAME xsi:type="string">${encodeText(name)}</NAME>\n${nest(defaultValueXml(value, usesTextData(pkgRoot)))}\n</VARIABLE>`;
  const summary = `add ${direction === 'local' ? 'variable' : direction === 'in' ? 'parameter' : 'return value'} ${name} = ${value} to ${node.path}`;
  if (section) return plan(summary, [insertChild(idx, section, xml, existing[existing.length - 1])]);
  const info = child(pkgRoot, 'INFORMATION');
  return plan(summary, [insertChild(idx, pkgRoot, `<VARIABLES xsi:type="variableContainer">\n${nest(xml)}\n</VARIABLES>`, info)]);
}

export function packageTemplate(progVersion: string, description = ''): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<PACKAGE format-rev="7" prog-version="${encodeAttr(progVersion)}" xmlns="http://www.tracetronic.de/xml/ecu-test" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.tracetronic.de/xml/ecu-test package.xsd">`,
    '\t<INFORMATION format-rev="2" xsi:type="packageInfo">',
    description ? `\t\t<DESCRIPTION xsi:type="string">${encodeText(description)}</DESCRIPTION>` : '\t\t<DESCRIPTION xsi:type="string"/>',
    '\t\t<VERSION xsi:type="string">1</VERSION>',
    '\t</INFORMATION>',
    '\t<VARIABLES xsi:type="variableContainer"/>',
    '\t<MAPPING format-rev="1" xsi:type="localMappingSpace"/>',
    '\t<TESTSTEPS xsi:type="testCase"/>',
    '</PACKAGE>',
    '',
  ].join('\n');
}

export function projectTemplate(): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<PROJECT format-rev="10" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '\t<NAME xsi:type="string">Project</NAME>',
    '\t<ENABLED xsi:type="boolean">True</ENABLED>',
    '\t<REPORTING xsi:type="boolean">True</REPORTING>',
    `\t<ID xsi:type="string">${randomUUID().replace(/-/g, '')}</ID>`,
    '\t<COMPONENTS/>',
    '</PROJECT>',
    '',
  ].join('\n');
}

const DEFAULT_PROG_VERSION = '2024.1.0';

/** Reference `file` (relative to the project's folder) from the project, creating a minimal package if needed. */
export function addPackage(ws: Workspace, targetPath: string, file: string, name?: string): EditPlan {
  const target = ws.resolve(targetPath);
  if (target.kind !== 'project' && target.kind !== 'folder') throw new Error(`${target.path} is a ${target.kind}; packages can be added to a project or a folder`);
  const model = ws.projectOf(target);
  const idx = ws.fileIndex(target);
  const rel = toPosix(file).replace(/^\.?\/+/, '');
  if (!/\.pkg$/i.test(rel) || rel.split('/').includes('..') || path.isAbsolute(file)) throw new Error(`"${file}" must be a .pkg path relative to the project folder, without ".."`);
  const abs = path.join(path.dirname(model.file), rel);
  // ECU-TEST resolves references against the workspace "Packages" folder: use it when the project lives in that workspace.
  const parts = toPosix(abs).split('/');
  const pk = parts.map((s) => s.toLowerCase()).lastIndexOf('packages');
  const workspaceDir = pk > 0 ? parts.slice(0, pk).join('/') : undefined;
  const inWorkspace = workspaceDir !== undefined && (toPosix(path.dirname(model.file)) + '/').startsWith(workspaceDir + '/');
  const raw = (inWorkspace ? parts.slice(pk + 1) : rel.split('/')).join('\\');
  if (ws.packagesOf(model).some((p) => p.ref?.resolved === abs)) throw new Error(`${rel} is already referenced by ${model.name}`);
  const withId = !!field(idx.root!, 'ID');
  const example = ws.packagesOf(model).find((p) => p.kind === 'packageRef');
  const lines = [
    `<COMPONENT format-rev="${(example && attr(example, 'format-rev')?.value) || '5'}" xsi:type="packageTest">`,
    `\t<NAME xsi:type="string">${encodeText(name ?? path.basename(rel).replace(/\.pkg$/i, ''))}</NAME>`,
    '\t<ENABLED xsi:type="boolean">True</ENABLED>',
    '\t<REPORTING xsi:type="boolean">True</REPORTING>',
    ...(withId ? [`\t<ID xsi:type="string">${randomUUID().replace(/-/g, '')}</ID>`] : []),
    '\t<COMPONENTS/>',
    '\t<PACKAGE-REF format-rev="1" style="relative" xsi:type="packageRef">',
    `\t\t<PACKAGE-PATH xsi:type="string">${encodeText(raw)}</PACKAGE-PATH>`,
    '\t</PACKAGE-REF>',
    '</COMPONENT>',
  ];
  const section = child(target, 'COMPONENTS');
  const lastField: Field | undefined = target.fields[target.fields.length - 1];
  const edit = section
    ? insertChild(idx, section, lines.join('\n'), section.children[section.children.length - 1])
    : insertChild(idx, target, `<COMPONENTS>\n${nest(lines.join('\n'))}\n</COMPONENTS>`, lastField?.element);
  const progVersion = (example?.pkg && attr(example.pkg, 'prog-version')?.value) || DEFAULT_PROG_VERSION;
  const creates = fs.existsSync(abs) ? [] : [{ file: abs, content: packageTemplate(progVersion) }];
  return plan(`add package ${rel} to ${target.path}${creates.length ? ' (new file)' : ' (existing file)'}`, [edit], creates);
}

export function newProject(ws: Workspace, file: string): EditPlan {
  const rel = toPosix(file);
  if (!/\.prj$/i.test(rel) || rel.split('/').includes('..') || path.isAbsolute(file)) throw new Error(`"${file}" must be a .prj path relative to the root, without ".."`);
  const abs = path.join(ws.opts.root, rel);
  if (fs.existsSync(abs)) throw new Error(`${rel} already exists`);
  return plan(`new project ${rel}`, [], [{ file: abs, content: projectTemplate() }]);
}

/** Fields in the same package that refer to a variable or mapping by name. */
function referencesTo(node: XNode): Field[] {
  const root = packageRootOf(node);
  const out: Field[] = [];
  if (!root || (node.kind !== 'parameter' && node.kind !== 'mapping')) return out;
  walk(root, (n) => {
    for (const f of n.fields) {
      if (f.value !== node.name) continue;
      const isVar = (f.tag === 'NAME' && n.type === 'varBaseExpression') || (f.tag === 'DVALUE' && n.tag === 'VARIABLE-NAME');
      if (node.kind === 'parameter' ? isVar : f.tag === 'MAPPING-REF') out.push(f);
    }
  });
  return out;
}

export function rename(ws: Workspace, target: string, name: string): EditPlan {
  const node = ws.resolve(target);
  const refs = nameRefs(node);
  if (!refs.length) {
    const why = node.kind === 'project' ? 'a project is named after its file; set /@NAME to change the display name' : `${node.label ?? node.kind} elements have no name; use set to change their value`;
    throw new Error(`Cannot rename ${node.path}: ${why}`);
  }
  const bad = validateName(node, name) ?? refs.map((r) => validateValue(r, name)).find(Boolean);
  if (bad) throw new Error(bad);
  if (node.kind !== 'step' && node.navParent?.navChildren.some((s) => s !== node && s.kind === node.kind && s.name === name)) throw new Error(`${node.navParent.path} already has a ${node.kind} named "${name}"`);
  const idx = ws.fileIndex(node);
  const edits = refs.map((r) => valueEdit(idx, r, name));
  const uses = referencesTo(node);
  for (const f of uses) edits.push({ file: idx.file, start: f.span.start, end: f.span.end, text: encodeText(name) });
  return plan(`rename ${node.path} to "${name}"${uses.length ? ` and ${uses.length} reference(s)` : ''}`, edits);
}

function assertRemovable(node: XNode, verb: string): void {
  if (node.kind === 'project' || node.kind === 'package' || node.tag === 'THEN' || node.tag === 'ELSE') throw new Error(`Cannot ${verb} ${node.path}: ${node.kind === 'step' ? 'Then/Else branches belong to their If step' : `a ${node.kind} is a file, not an element`}`);
}

export function deleteNode(ws: Workspace, target: string): EditPlan {
  const node = ws.resolve(target);
  assertRemovable(node, 'delete');
  const idx = ws.fileIndex(node);
  const span = removalSpan(idx.text, node);
  const uses = referencesTo(node).length;
  const note = node.kind === 'packageRef' ? ' (the .pkg file is kept)' : uses ? ` (warning: still referenced ${uses} time(s) in the package)` : '';
  return plan(`delete ${node.path}${note}`, [{ file: idx.file, ...span, text: '' }]);
}

/** Move an element next to a sibling-compatible element of the same file (reorder or re-parent). */
export function moveNode(ws: Workspace, target: string, where: { after?: string; before?: string }): EditPlan {
  const node = ws.resolve(target);
  assertRemovable(node, 'move');
  const refPath = where.after ?? where.before;
  if (!refPath || (where.after && where.before)) throw new Error('move needs exactly one of --after <path> or --before <path>');
  const ref = ws.resolve(refPath);
  if (ref === node) throw new Error('Cannot move an element relative to itself');
  if (ref.file !== node.file || ref.tag !== node.tag || ref.kind !== node.kind) throw new Error(`${ref.path} is not a compatible position for ${node.path}: both must be the same kind of element in the same file`);
  for (let p: XNode | undefined = ref; p; p = p.parent) if (p === node) throw new Error('Cannot move an element into itself');
  assertRemovable(ref, 'move next to');
  const idx = ws.fileIndex(node);
  const from = indentAt(idx.text, node.start);
  const to = indentAt(idx.text, ref.start);
  const body = idx.text.slice(node.start, node.end);
  const moved = from === to ? body : body.split('\n').map((l, i) => (i > 0 && l.startsWith(from) ? to + l.slice(from.length) : l)).join('\n');
  const insert: TextEdit = where.after ? { file: idx.file, start: ref.end, end: ref.end, text: idx.eol + to + moved } : { file: idx.file, start: ref.start, end: ref.start, text: moved + idx.eol + to };
  return plan(`move ${node.path} ${where.after ? 'after' : 'before'} ${ref.path}`, [{ file: idx.file, ...removalSpan(idx.text, node), text: '' }, insert]);
}
