// Single-pass streaming XML indexer. No DOM, no re-serialisation: the text is scanned once with a tag stack,
// leaf elements are folded into their parent as fields, and every node records the offsets edits need.
import { Attr, Diagnostic, Field, FileIndex, XNode } from './model';
import { classify, isStructural } from './schema';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

export function encodeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function encodeAttr(s: string): string {
  return encodeText(s).replace(/"/g, '&quot;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
}

interface Open {
  node: XNode;
  /** Raw text pieces directly inside this element, used when it turns out to be a leaf. */
  textStart: number;
  textEnd: number;
  cdata: boolean;
  hasText: boolean;
}

class LineIndex {
  private starts: number[] = [0];
  constructor(text: string) {
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) this.starts.push(i + 1);
  }
  lineAt(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}

const NAME_END = /[\s/>=]/;

function parseAttrs(text: string, from: number, to: number): Attr[] {
  const attrs: Attr[] = [];
  let i = from;
  while (i < to) {
    while (i < to && /\s/.test(text[i])) i++;
    if (i >= to || text[i] === '/' || text[i] === '>') break;
    const nameStart = i;
    while (i < to && !NAME_END.test(text[i])) i++;
    const name = text.slice(nameStart, i);
    while (i < to && /\s/.test(text[i])) i++;
    if (text[i] !== '=') continue;
    i++;
    while (i < to && /\s/.test(text[i])) i++;
    const quote = text[i];
    if (quote !== '"' && quote !== "'") continue;
    const close = text.indexOf(quote, i + 1);
    if (close === -1 || close > to) break;
    attrs.push({ name, value: decodeXml(text.slice(i + 1, close)), span: { start: i + 1, end: close } });
    i = close + 1;
  }
  return attrs;
}

/** End offset of a start tag beginning at `lt`, honouring quoted '>' characters. */
function findTagEnd(text: string, lt: number): number {
  let quote = '';
  for (let i = lt + 1; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

function toField(o: Open, text: string): Field {
  const n = o.node;
  const raw = o.hasText ? text.slice(o.textStart, o.textEnd) : '';
  return {
    tag: n.tag,
    value: o.cdata ? raw : decodeXml(raw),
    span: o.hasText ? { start: o.textStart, end: o.textEnd } : { start: n.inner.start, end: n.inner.end },
    element: { start: n.start, end: n.end },
    selfClosing: n.selfClosing,
    cdata: o.cdata,
    attrs: n.attrs,
    line: n.line,
  };
}

/** Index one file's text (without BOM). Never throws: malformed input produces diagnostics. */
export function parseText(file: string, text: string, bom = false): FileIndex {
  const diagnostics: Diagnostic[] = [];
  const lines = new LineIndex(text);
  const stack: Open[] = [];
  let root: XNode | undefined;
  const warn = (message: string, offset: number) =>
    diagnostics.push({ severity: 'error', message, file, line: lines.lineAt(offset) });

  const close = (o: Open, start: number, end: number) => {
    const n = o.node;
    n.end = end;
    if (!n.selfClosing) n.inner.end = start;
    const parent = stack[stack.length - 1];
    if (!parent) {
      if (!root) root = n;
      return;
    }
    // Leaf elements become fields of the parent; elements with structure become nodes.
    if (n.children.length === 0 && n.fields.length === 0 && !isStructural(n.tag)) parent.node.fields.push(toField(o, text));
    else {
      n.parent = parent.node;
      parent.node.children.push(n);
    }
  };

  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const top = stack[stack.length - 1];
    const textTo = lt === -1 ? text.length : lt;
    if (top && textTo > i && /\S/.test(text.slice(i, textTo)) && !top.cdata) {
      if (!top.hasText) top.textStart = i;
      top.hasText = true;
      top.textEnd = textTo;
    }
    if (lt === -1) break;
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      i = e === -1 ? text.length : e + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt + 9);
      const to = e === -1 ? text.length : e;
      if (top && !top.hasText) {
        top.hasText = true;
        top.cdata = true;
        top.textStart = lt + 9;
        top.textEnd = to;
      }
      i = e === -1 ? text.length : e + 3;
    } else if (text[lt + 1] === '?' || text[lt + 1] === '!') {
      const e = text.indexOf('>', lt);
      i = e === -1 ? text.length : e + 1;
    } else if (text[lt + 1] === '/') {
      const gt = text.indexOf('>', lt);
      if (gt === -1) {
        warn('Unterminated end tag', lt);
        break;
      }
      const tag = text.slice(lt + 2, gt).trim();
      let depth = stack.length - 1;
      while (depth >= 0 && stack[depth].node.tag !== tag) depth--;
      if (depth < 0) warn(`Unexpected end tag </${tag}>`, lt);
      else {
        while (stack.length - 1 > depth) {
          const o = stack.pop()!;
          warn(`Element <${o.node.tag}> is not closed`, o.node.start);
          close(o, lt, lt);
        }
        close(stack.pop()!, lt, gt + 1);
      }
      i = gt + 1;
    } else {
      const gt = findTagEnd(text, lt);
      if (gt === -1) {
        warn('Unterminated start tag', lt);
        break;
      }
      const selfClosing = text[gt - 1] === '/';
      let nameEnd = lt + 1;
      while (nameEnd < gt && !NAME_END.test(text[nameEnd])) nameEnd++;
      const node: XNode = {
        kind: 'element',
        tag: text.slice(lt + 1, nameEnd),
        name: '',
        file,
        line: lines.lineAt(lt),
        start: lt,
        end: gt + 1,
        inner: { start: gt + 1, end: gt + 1 },
        selfClosing,
        attrs: parseAttrs(text, nameEnd, selfClosing ? gt - 1 : gt),
        fields: [],
        children: [],
        path: '',
        navChildren: [],
      };
      const open: Open = { node, textStart: gt + 1, textEnd: gt + 1, cdata: false, hasText: false };
      if (selfClosing) close(open, gt + 1, gt + 1);
      else stack.push(open);
      i = gt + 1;
    }
  }
  while (stack.length) {
    const o = stack.pop()!;
    warn(`Element <${o.node.tag}> is not closed`, o.node.start);
    close(o, text.length, text.length);
  }
  if (!root) diagnostics.push({ severity: 'error', message: 'No XML root element found', file, line: 1 });
  else classify(root);
  return { file, text, bom, eol: text.includes('\r\n') ? '\r\n' : '\n', root, diagnostics };
}
