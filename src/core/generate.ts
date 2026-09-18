// The test.h generation model: which packages/steps become which C functions. This mirrors the dummy generator
// (scripts/generate.mjs): every top-level block of an enabled package test case becomes one
// `void TC_<package>_<case>(void)`; precondition/postcondition blocks are emitted into every case.
import * as path from 'path';
import { attr, child, field, XNode } from './model';
import { Workspace } from './workspace';

export interface GenCase {
  function: string;
  /** Path of the block (or package, for the implicit `main` case) the function is generated from. */
  path: string;
  packagePath: string;
  packageFile: string;
  title: string;
  /** Rendered function text: header comment, signature and body. */
  text: string;
}

export function cIdent(s: string): string {
  return s.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
}

const quote = (s: string) => JSON.stringify(s);

function resultVar(step: XNode): string | undefined {
  const refs = child(step, 'VARIABLE-REFS')?.children.find((c) => attr(c, 'dkey')?.value === 'default');
  return refs && field(refs, 'DVALUE')?.value;
}

/** Pseudo-C lines for one step (recursive). */
export function stepLines(step: XNode, indent = ''): string[] {
  const kids = (n: XNode) => n.navChildren.filter((c) => c.kind === 'step').flatMap((c) => stepLines(c, indent + '    '));
  const mapping = field(step, 'MAPPING-REF')?.value ?? '';
  // Literal strings are quoted; variable references (NAME of a varBaseExpression) and composite expressions are not.
  const v = step.valueRef?.tag === 'VALUE' && step.valueRef.type === 'string' ? quote(step.value ?? '') : step.value ?? '';
  const target = resultVar(step);
  const line = (s: string) => [indent + s];
  switch (step.label) {
    case 'TsBlock':
    case 'TsPrecondBlock':
    case 'TsPostcondBlock':
    case 'TsMultiCheck':
      return [...line(`/* -- ${step.name} -- */`), ...step.navChildren.filter((c) => c.kind === 'step').flatMap((c) => stepLines(c, indent))];
    case 'TsComment':
      return line(`/* ${(step.value ?? '').replace(/\*\//g, '* /')} */`);
    case 'TsWait':
      return line(`TEST_WAIT(${v});`);
    case 'TsLoop':
      return [...line(`for (int i = 0; i < ${v}; ++i) {`), ...kids(step), ...line('}')];
    case 'TsBreak':
      return line('break;');
    case 'TsIfThenElse': {
      const [then, otherwise] = ['THEN', 'ELSE'].map((tag) => step.navChildren.find((c) => c.tag === tag));
      const elseLines = otherwise ? kids(otherwise) : [];
      return [...line(`if (${v}) {`), ...(then ? kids(then) : []), ...(elseLines.length ? [...line('} else {'), ...elseLines] : []), ...line('}')];
    }
    case 'TsSwitchCase':
      return [...line(`switch (${v}) {`), ...step.navChildren.filter((c) => c.kind === 'step').flatMap((c) => stepLines(c, indent)), ...line('}')];
    case 'caseNode':
      return [...line(`case ${v || 'default'}:`), ...kids(step), ...line('    break;')];
    case 'TsCalculation':
      return line(target ? `${target} = ${v};` : `TEST_EVAL(${v});`);
    case 'tsRead':
      return line(`${target ? `${target} = ` : ''}TEST_READ(${quote(mapping)});`);
    case 'tsWrite':
      return line(`TEST_WRITE(${quote(mapping)}, ${v});`);
    case 'tsPackage':
      return line(`PKG_${cIdent(path.basename((step.value ?? 'dynamic').replace(/\\/g, '/')).replace(/\.pkg$/i, ''))}();`);
    default:
      return line(`/* ${step.label ?? step.tag}${step.value ? ': ' + step.value : ''} */`);
  }
}

function enabled(node: XNode): boolean {
  for (let n: XNode | undefined = node; n; n = n.navParent) if (field(n, 'ENABLED')?.value === 'False') return false;
  return true;
}

function renderCase(fn: string, casePath: string, pkgFile: string, title: string, body: string[]): string {
  const header = ['/* @case ' + casePath, ` * package: ${pkgFile}`, ` * title: ${title}`, ' * steps:', ...body.map((l) => ' *   ' + l.replace(/\/\*|\*\//g, '').trim()).filter((l) => l !== ' *   }'), ' */'];
  return [...header, `void ${fn}(void)`, '{', ...body.map((l) => '    ' + l), '}'].join('\n');
}

/** Test cases generated from one package test case component. */
export function casesOfPackage(ws: Workspace, pkg: XNode, used = new Set<string>()): GenCase[] {
  if (pkg.kind !== 'packageRef' || !pkg.pkg || !enabled(pkg)) return [];
  const steps = pkg.navChildren.filter((c) => c.kind === 'step');
  const pre = steps.filter((s) => s.label === 'TsPrecondBlock').flatMap((s) => stepLines(s));
  const post = steps.filter((s) => s.label === 'TsPostcondBlock').flatMap((s) => stepLines(s));
  const blocks = steps.filter((s) => s.label === 'TsBlock');
  const loose = steps.filter((s) => !/^Ts(Precond|Postcond)?Block$/.test(s.label ?? ''));
  const pkgFile = path.relative(ws.opts.root, pkg.pkg.file).replace(/\\/g, '/');
  const base = cIdent(path.basename(pkgFile).replace(/\.pkg$/i, ''));
  const make = (node: XNode, title: string, body: string[]): GenCase => {
    let fn = `TC_${base}_${cIdent(title)}`;
    for (let n = 2; used.has(fn); n++) fn = `TC_${base}_${cIdent(title)}_${n}`;
    used.add(fn);
    return { function: fn, path: node.path, packagePath: pkg.path, packageFile: pkgFile, title, text: renderCase(fn, node.path, pkgFile, title, [...pre, ...body, ...post]) };
  };
  const cases = blocks.map((b) => make(b, b.name, stepLines(b)));
  if (loose.length || !blocks.length) cases.unshift(make(pkg, 'main', loose.flatMap((s) => stepLines(s))));
  return cases;
}

/** All cases below `node` (a project, folder, package or anything inside a package). */
export function generateModel(ws: Workspace, node?: XNode): GenCase[] {
  const used = new Set<string>();
  const all = ws.projects.flatMap((p) => ws.packagesOf(p).flatMap((pkg) => casesOfPackage(ws, pkg, used)));
  if (!node) return all;
  const inside = (p: string, of: string) => p === of || p.startsWith(of + '/');
  if (node.kind === 'project') return all.filter((c) => inside(c.packagePath, node.path));
  if (node.kind === 'folder') {
    const pkgs = new Set<string>();
    const collect = (n: XNode) => n.navChildren.forEach((c) => (c.kind === 'packageRef' ? pkgs.add(c.path) : collect(c)));
    collect(node);
    return all.filter((c) => pkgs.has(c.packagePath));
  }
  // Inside a package: the case containing the node, or every case of the package for shared parts.
  const exact = all.filter((c) => c.path !== c.packagePath && inside(node.path, c.path));
  return exact.length ? exact : all.filter((c) => inside(node.path, c.packagePath));
}

export function renderHeader(cases: GenCase[], title: string): string {
  const lines = ['/* Generated by the ECU-TEST Viewer & Editor dummy generator. DO NOT EDIT. */', `/* source: ${title} */`, '#ifndef TEST_H', '#define TEST_H', ''];
  for (const c of cases) lines.push(c.text, '');
  lines.push('#endif /* TEST_H */', '');
  return lines.join('\n');
}
