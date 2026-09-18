// Compact JSON and text views for the CLI, the MCP server and the webviews.
import * as path from 'path';
import { DiffResult } from './diff';
import { EditPlan } from './edit';
import { XNode } from './model';
import { Workspace } from './workspace';

export interface NodeView {
  path: string;
  kind: string;
  type?: string;
  name: string;
  value?: string;
  editable?: boolean;
  source: string;
  problems?: string[];
  fields?: Record<string, string>;
  attributes?: Record<string, string>;
  children?: NodeView[];
  childCount?: number;
}

const rel = (ws: Workspace, file: string) => path.relative(ws.opts.root, file).replace(/\\/g, '/');

export function nodeView(ws: Workspace, node: XNode, depth = 1): NodeView {
  const problems = ws.diagnostics.filter((d) => d.path === node.path).map((d) => d.message);
  const view: NodeView = { path: node.path, kind: node.kind, type: node.label ?? node.type, name: node.name, value: node.value, editable: node.valueRef ? true : undefined, source: `${rel(ws, node.file)}:${node.line}` };
  if (problems.length) view.problems = problems;
  if (node.ref) view.fields = { 'PACKAGE-PATH': node.ref.raw };
  if (node.fields.length) view.fields = { ...view.fields, ...Object.fromEntries(node.fields.map((f) => [f.tag, f.value])) };
  if (node.attrs.length) view.attributes = Object.fromEntries(node.attrs.filter((a) => !a.name.startsWith('xmlns') && a.name !== 'xsi:schemaLocation').map((a) => [a.name, a.value]));
  if (depth > 0) view.children = node.navChildren.map((c) => nodeView(ws, c, depth - 1));
  else if (node.navChildren.length) view.childCount = node.navChildren.length;
  return view;
}

/** One line per node: "<last path segment> [type] = value". Package lines show their full path. */
export function treeLines(node: XNode, depth = 2, indent = ''): string[] {
  const segment = node.kind === 'packageRef' || node.kind === 'package' || !node.navParent ? node.path : node.path.slice(node.navParent.path.length + 1);
  const value = node.value !== undefined && node.value !== '' ? ` = ${node.value.replace(/\s+/g, ' ').slice(0, 100)}` : '';
  const missing = node.kind === 'packageRef' && !node.pkg ? '  !missing' : '';
  const line = `${indent}${segment} [${node.label ?? node.kind}]${value}${missing}`;
  if (depth <= 0) return [node.navChildren.length ? `${line}  (+${node.navChildren.length})` : line];
  return [line, ...node.navChildren.flatMap((c) => treeLines(c, depth - 1, indent + '  '))];
}

export function infoView(ws: Workspace) {
  return {
    root: ws.opts.root,
    projects: ws.projects.map((p) => ({
      path: p.index.root?.path ?? `(unreadable) ${p.name}`,
      file: rel(ws, p.file),
      packages: ws.packagesOf(p).map((n) => ({ path: n.path, file: n.pkg || n.kind === 'package' ? rel(ws, (n.pkg ?? n).file) : null, missing: n.kind === 'packageRef' && !n.pkg ? n.ref?.raw : undefined, calledOnly: n.kind === 'package' || undefined })),
    })),
    counts: ws.counts(),
    diagnostics: ws.diagnostics.map((d) => ({ severity: d.severity, message: d.message, source: `${rel(ws, d.file)}:${d.line}`, path: d.path })),
  };
}

export function searchView(ws: Workspace, nodes: XNode[]) {
  return nodes.map((n) => ({ path: n.path, kind: n.kind, type: n.label ?? n.type, value: n.value, source: `${rel(ws, n.file)}:${n.line}` }));
}

export function planView(ws: Workspace, plan: EditPlan, applied: boolean) {
  return {
    summary: plan.summary,
    applied,
    edits: plan.edits.map((e) => ({ file: rel(ws, e.file), start: e.start, end: e.end, text: e.text })),
    creates: plan.creates.map((c) => ({ file: rel(ws, c.file), bytes: c.content.length })),
  };
}

export function diffView(ws: Workspace, diff: DiffResult) {
  return { generatedDir: rel(ws, diff.generatedDir), files: diff.files, upToDate: diff.entries.length === 0, same: diff.same, differences: diff.entries };
}
