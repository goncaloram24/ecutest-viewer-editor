// Loads projects and their packages, builds the merged navigation tree and the path index.
import * as path from 'path';
import { applyPlanToDisk, EditPlan, readTextFile } from './edit';
import { child, Diagnostic, field, FileIndex, XNode } from './model';
import { parseText } from './parser';
import { DiscoveryOptions, findProjects, resolvePackage, toPosix } from './project';

export interface ProjectModel {
  name: string;
  file: string;
  index: FileIndex;
  /**
   * Package files loaded for this project, by absolute file name. A package referenced several times is indexed
   * once per reference, so every reference shows (and addresses) its own copy of the contents.
   */
  packages: Map<string, FileIndex[]>;
  /** Packages that are only reached through package-call steps, shown below the project. */
  called: { root: XNode; raw: string }[];
}

export function escapeSegment(name: string): string {
  return name.replace(/%/g, '%25').replace(/\//g, '%2F').replace(/#/g, '%23').replace(/^@/, '%40').trim() || '_';
}

/** Address of a package reference: forward slashes, no extension, no drive or leading slash. */
export function packageSegment(raw: string): string {
  return toPosix(raw.trim()).replace(/^([a-zA-Z]:)?\/+/, '').replace(/\.pkg$/i, '').split('/').map(escapeSegment).join('/');
}

export class Workspace {
  projects: ProjectModel[] = [];
  diagnostics: Diagnostic[] = [];
  private index = new Map<string, XNode>();
  private lower = new Map<string, XNode>();

  constructor(public opts: DiscoveryOptions) {
    this.opts = { ...opts, root: path.resolve(opts.root) };
  }

  static load(opts: DiscoveryOptions): Workspace {
    const ws = new Workspace(opts);
    ws.reload();
    return ws;
  }

  reload(): void {
    this.projects = findProjects(this.opts).map((file) => this.loadProject(file));
    this.disambiguateProjects();
    this.rebuild();
  }

  /** Re-index one file after it changed. A package is re-parsed alone; a project file reloads that project. */
  reloadFile(file: string): 'package' | 'project' | 'none' {
    const abs = path.resolve(file);
    let result: 'package' | 'project' | 'none' = 'none';
    this.projects = this.projects.map((p) => {
      if (p.file === abs) {
        result = 'project';
        return this.loadProject(abs);
      }
      if (p.packages.has(abs)) {
        if (result === 'none') result = 'package';
        p.packages.set(abs, [this.parseFile(abs)]);
      }
      return p;
    });
    if (result === 'none' && /\.prj$/i.test(abs) && findProjects(this.opts).includes(abs)) {
      this.projects.push(this.loadProject(abs));
      result = 'project';
    }
    if (result !== 'none') {
      this.disambiguateProjects();
      this.rebuild();
    }
    return result;
  }

  /** Apply a plan on disk and re-index the touched files. */
  apply(plan: EditPlan): string[] {
    const touched = applyPlanToDisk(plan);
    if (touched.some((f) => this.reloadFile(f) === 'none')) this.reload();
    return touched;
  }

  files(): string[] {
    return this.projects.flatMap((p) => [p.file, ...p.packages.keys()]);
  }

  fileIndex(node: XNode): FileIndex {
    for (const p of this.projects) {
      const top = rootOf(node);
      const idx = p.file === node.file && p.index.root === top ? p.index : p.packages.get(node.file)?.find((i) => i.root === top);
      if (idx) return idx;
    }
    throw new Error(`File of ${node.path} is not loaded`);
  }

  roots(): XNode[] {
    return this.projects.map((p) => p.index.root).filter((r): r is XNode => !!r);
  }

  all(): XNode[] {
    return [...this.index.values()];
  }

  get(p: string): XNode | undefined {
    const key = '/' + p.trim().replace(/^\/+|\/+$/g, '');
    return this.index.get(key) ?? this.lower.get(key.toLowerCase());
  }

  /** Resolve a path or throw an error that tells the caller how to find valid paths. */
  resolve(p: string): XNode {
    const node = this.get(p);
    if (node) return node;
    const parent = this.get(p.replace(/\/[^/]*$/, ''));
    const hint = parent ? `Children of ${parent.path}: ${parent.navChildren.map((c) => c.path.slice(parent.path.length + 1)).join(', ') || '(none)'}` : `Known projects: ${this.roots().map((r) => r.path).join(', ') || '(none)'}`;
    throw new Error(`No element at path "${p}". ${hint}. Use search or tree to find paths.`);
  }

  projectOf(node: XNode): ProjectModel {
    let top = node;
    while (top.navParent) top = top.navParent;
    const found = this.projects.find((p) => p.index.root === top);
    if (!found) throw new Error(`No project for ${node.path}`);
    return found;
  }

  search(text: string, limit = 50): XNode[] {
    const q = text.toLowerCase();
    const hit = (n: XNode) =>
      n.name.toLowerCase().includes(q) || (n.value ?? '').toLowerCase().includes(q) || (n.label ?? '').toLowerCase().includes(q) || n.fields.some((f) => f.value.toLowerCase().includes(q)) || n.attrs.some((a) => a.name === 'id' && a.value.toLowerCase() === q);
    return this.all().filter(hit).slice(0, limit);
  }

  private parseFile(file: string): FileIndex {
    try {
      const { text, bom } = readTextFile(file);
      return parseText(file, text, bom);
    } catch (e) {
      return { file, text: '', bom: false, eol: '\n', diagnostics: [{ severity: 'error', message: `Cannot read file: ${(e as Error).message}`, file, line: 1 }] };
    }
  }

  private loadProject(file: string): ProjectModel {
    const index = this.parseFile(file);
    const model: ProjectModel = { name: path.basename(file).replace(/\.prj$/i, ''), file, index, packages: new Map(), called: [] };
    if (index.root && index.root.kind !== 'project') {
      index.diagnostics.push({ severity: 'error', message: `Root element is <${index.root.tag}>, expected <PROJECT>`, file, line: index.root.line });
    }
    return model;
  }

  private disambiguateProjects(): void {
    const seen = new Map<string, number>();
    for (const p of this.projects) {
      const base = path.basename(p.file).replace(/\.prj$/i, '');
      const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
      seen.set(base.toLowerCase(), n);
      p.name = n === 1 ? base : `${base}#${n}`;
    }
  }

  /**
   * The index of the package a reference points at. With `linked`, an instance whose contents are not shown yet
   * is returned (parsing the file again if needed); without it, any instance will do (package calls).
   */
  private loadPackage(model: ProjectModel, raw: string, from: XNode, linked?: Set<XNode>): FileIndex | undefined {
    const resolved = resolvePackage(raw, model.file, { ...this.opts, packageBaseDirs: [...(this.opts.packageBaseDirs ?? []), path.dirname(from.file)] });
    if (!resolved) {
      this.diagnostics.push({ severity: 'error', message: `Missing package "${raw}" referenced by ${from.path || from.name}`, file: from.file, line: from.line, path: from.path });
      return undefined;
    }
    const instances = model.packages.get(resolved) ?? [];
    model.packages.set(resolved, instances);
    let idx = linked ? instances.find((i) => !i.root || !linked.has(i.root)) : instances[0];
    if (!idx) instances.push((idx = this.parseFile(resolved)));
    return idx;
  }

  /** Rebuild navigation links, paths, the path index and diagnostics from the parsed files. */
  private rebuild(): void {
    this.index.clear();
    this.diagnostics = [];
    for (const model of this.projects) {
      const root = model.index.root;
      if (!root) {
        this.diagnostics.push(...model.index.diagnostics);
        continue;
      }
      model.called = [];
      root.path = '/' + escapeSegment(model.name);
      root.name = model.name;
      root.navParent = undefined;
      this.index.set(root.path, root);
      const linked = new Set<XNode>();
      this.link(model, root, root, linked);
      // Packages reached only through call steps are listed below the project so they are addressable too.
      for (let i = 0; i < model.called.length; i++) {
        const { root: pkgRoot, raw } = model.called[i];
        if (linked.has(pkgRoot)) continue;
        pkgRoot.navParent = root;
        pkgRoot.name = path.basename(pkgRoot.file).replace(/\.pkg$/i, '');
        root.navChildren.push(pkgRoot);
        this.assign(pkgRoot, root.path + '/' + packageSegment(raw));
        this.link(model, pkgRoot, root, linked);
      }
      // Drop instances that are no longer referenced; report each file's own problems once.
      for (const [file, instances] of [...model.packages]) {
        const used = instances.filter((i, n) => (i.root ? linked.has(i.root) : n === 0));
        if (used.length) model.packages.set(file, used);
        else model.packages.delete(file);
      }
      for (const idx of [model.index, ...[...model.packages.values()].map((i) => i[0])]) this.diagnostics.push(...idx.diagnostics);
    }
    this.lower = new Map([...this.index].reverse().map(([k, n]) => [k.toLowerCase(), n]));
  }

  private assign(node: XNode, p: string): void {
    let unique = p;
    for (let n = 2; this.index.has(unique); n++) unique = `${p}#${n}`;
    node.path = unique;
    this.index.set(unique, node);
  }

  /** Compute navChildren for `node` and everything below it, assigning paths on the way. */
  private link(model: ProjectModel, node: XNode, projectRoot: XNode, linked: Set<XNode>): void {
    if (linked.has(node)) return;
    linked.add(node);
    const kids: XNode[] = [];
    // Skip wrappers, and children that only hold the owner's own name/value (ACTION, TIME, DEFAULT-VALUE, ...).
    const inside = (r: { span: { start: number; end: number } } | undefined, c: XNode) => !!r && r.span.start >= c.start && r.span.end <= c.end;
    const simple = (c: XNode): boolean => c.tag === 'DEFAULT-VALUE' || (c.fields.length + c.children.length === 1 && c.children.every(simple));
    const holdsOwn = (owner: XNode, c: XNode) => inside(owner.nameRef, c) || (inside(owner.valueRef, c) && simple(c));
    const contents = (owner: XNode) => {
      for (const c of owner.children) {
        if (c.kind === 'section') kids.push(...c.children);
        else if (c.tag !== 'PACKAGE-REF' && c.kind !== 'info' && !holdsOwn(owner, c)) kids.push(c);
      }
    };
    contents(node);
    if (node.kind === 'packageRef' && node.ref) {
      const idx = this.loadPackage(model, node.ref.raw, node, linked);
      node.ref.resolved = idx?.file;
      node.pkg = idx?.root?.kind === 'package' ? idx.root : undefined;
      if (node.pkg) {
        linked.add(node.pkg);
        contents(node.pkg);
      } else if (idx?.root && idx.root.kind !== 'package') {
        this.diagnostics.push({ severity: 'error', message: `"${node.ref.raw}" is not an ECU-TEST package (root <${idx.root.tag}>)`, file: node.file, line: node.line, path: node.path });
      }
    }
    node.navChildren = kids;
    for (const k of kids) {
      k.navParent = node;
      const segment = k.kind === 'packageRef' && k.ref ? packageSegment(k.ref.raw || k.name) : escapeSegment(k.name);
      // Packages are addressed directly below their project, whatever folder they sit in.
      this.assign(k, (k.kind === 'packageRef' ? projectRoot.path : node.path) + '/' + segment);
      this.link(model, k, projectRoot, linked);
    }
    if (node.kind === 'step' && node.label === 'tsPackage') this.linkCall(model, node, linked);
  }

  private linkCall(model: ProjectModel, step: XNode, linked: Set<XNode>): void {
    const ref = child(step, 'PACKAGE-REFERENCE');
    const literal = ref?.type === 'valueBaseExpression' ? field(ref, 'VALUE')?.value : undefined;
    if (!literal) return;
    const idx = this.loadPackage(model, literal, step);
    const root = idx?.root;
    if (root && root.kind === 'package' && !linked.has(root) && !model.called.some((c) => c.root === root)) model.called.push({ root, raw: literal });
  }

  /** Packages (navigation nodes) of a project: referenced test cases and call-only packages. */
  packagesOf(model: ProjectModel): XNode[] {
    const out: XNode[] = [];
    const root = model.index.root;
    if (root) walkNav(root, (n) => void ((n.kind === 'packageRef' || n.kind === 'package') && out.push(n)));
    return out;
  }

  counts(): Record<string, number> {
    const counts: Record<string, number> = { projects: this.projects.length, files: new Set(this.files()).size };
    for (const n of new Set(this.index.values())) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
    return counts;
  }
}

export function rootOf(node: XNode): XNode {
  let r = node;
  while (r.parent) r = r.parent;
  return r;
}

export function walkNav(node: XNode, visit: (n: XNode) => void): void {
  visit(node);
  for (const c of node.navChildren) walkNav(c, visit);
}

/** The PACKAGE root that contains `node` (or that a packageRef points at). */
export function packageRootOf(node: XNode): XNode | undefined {
  if (node.pkg) return node.pkg;
  const r = rootOf(node);
  return r.kind === 'package' ? r : undefined;
}
