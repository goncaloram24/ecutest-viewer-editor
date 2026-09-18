// Node types, spans and the per-file index. Everything the tool knows about a file is an offset into its text.

export interface Span {
  start: number;
  end: number;
}

/** An XML attribute; `span` covers the raw value between the quotes. */
export interface Attr {
  name: string;
  value: string;
  span: Span;
}

/** A leaf child element folded into its parent, e.g. <NAME xsi:type="string">x</NAME>. */
export interface Field {
  tag: string;
  value: string;
  /** Range of the raw text content. For a self-closing element it is empty and `selfClosing` is set. */
  span: Span;
  element: Span;
  selfClosing: boolean;
  cdata: boolean;
  attrs: Attr[];
  line: number;
}

export type NodeKind =
  | 'project'
  | 'package'
  | 'packageRef'
  | 'folder'
  | 'step'
  | 'parameter'
  | 'mapping'
  | 'info'
  | 'section'
  | 'element';

/** Where an editable value lives: element text or an attribute value. */
export interface ValueRef {
  value: string;
  span: Span;
  /** 'text' values are XML-text encoded, 'attr' values attribute encoded, 'empty' replaces a self-closing element. */
  where: 'text' | 'attr' | 'empty';
  tag: string;
  cdata?: boolean;
  /** xsi:type of the holding element (string, integer, float, boolean, ...). */
  type?: string;
}

export interface XNode {
  kind: NodeKind;
  tag: string;
  /** xsi:type if present. */
  type?: string;
  /** Step type / friendly type label (e.g. "TsBlock", "TsWrite"). */
  label?: string;
  name: string;
  nameRef?: ValueRef;
  /** Display value (expression text, reference, default value); editable when `valueRef` is set. */
  value?: string;
  valueRef?: ValueRef;
  file: string;
  line: number;
  start: number;
  end: number;
  /** Content range between the start tag and the end tag; insertions of children go here. */
  inner: Span;
  selfClosing: boolean;
  attrs: Attr[];
  fields: Field[];
  children: XNode[];
  parent?: XNode;
  /** Stable address, assigned by the workspace. */
  path: string;
  /** Logical (navigation) tree, assigned by the workspace; wrappers like COMPONENTS/TESTSTEPS are skipped. */
  navChildren: XNode[];
  navParent?: XNode;
  /** For packageRef nodes: the PACKAGE root of the loaded file. */
  pkg?: XNode;
  /** For packageRef: the resolved file (if found) and the raw reference text. */
  ref?: { raw: string; resolved?: string };
}

export interface Diagnostic {
  severity: 'error' | 'warning';
  message: string;
  file: string;
  line: number;
  path?: string;
}

export interface FileIndex {
  file: string;
  text: string;
  bom: boolean;
  eol: '\r\n' | '\n';
  root?: XNode;
  diagnostics: Diagnostic[];
}

export function attr(node: { attrs: Attr[] }, name: string): Attr | undefined {
  return node.attrs.find((a) => a.name === name);
}

export function field(node: XNode, tag: string): Field | undefined {
  return node.fields.find((f) => f.tag === tag);
}

export function child(node: XNode, tag: string): XNode | undefined {
  return node.children.find((c) => c.tag === tag);
}

export function walk(node: XNode, visit: (n: XNode) => void): void {
  visit(node);
  for (const c of node.children) walk(c, visit);
}

export function fieldRef(f: Field): ValueRef {
  return {
    value: f.value,
    span: f.selfClosing ? f.element : f.span,
    where: f.selfClosing ? 'empty' : 'text',
    tag: f.tag,
    cdata: f.cdata,
    type: attr(f, 'xsi:type')?.value,
  };
}

export function attrRef(a: Attr): ValueRef {
  return { value: a.value, span: a.span, where: 'attr', tag: a.name };
}
