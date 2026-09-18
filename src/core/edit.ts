// Text edits: the only way files are ever modified. Offsets are string offsets into the file's text
// without BOM (the same coordinates VS Code documents use).
import * as fs from 'fs';
import * as path from 'path';

const BOM = String.fromCharCode(0xfeff);

export interface TextEdit {
  file: string;
  start: number;
  end: number;
  text: string;
}

/** A new file to be written (add-package, new-project). */
export interface FileCreate {
  file: string;
  content: string;
}

export interface EditPlan {
  summary: string;
  edits: TextEdit[];
  creates: FileCreate[];
}

/** Apply edits for one file to its text. Edits must not overlap; order does not matter. */
export function applyEdits(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let last = Infinity;
  for (const e of sorted) {
    if (e.start > e.end || e.end > last || e.start < 0 || e.end > text.length) {
      throw new Error(`Overlapping or out-of-range edit at ${e.start}-${e.end}`);
    }
    text = text.slice(0, e.start) + e.text + text.slice(e.end);
    last = e.start;
  }
  return text;
}

export function groupByFile(edits: TextEdit[]): Map<string, TextEdit[]> {
  const map = new Map<string, TextEdit[]>();
  for (const e of edits) {
    const list = map.get(e.file);
    if (list) list.push(e);
    else map.set(e.file, [e]);
  }
  return map;
}

export type TextEncoding = 'utf8' | 'utf16le';

/**
 * Read a file as text, separating a leading BOM so offsets match editor coordinates. UTF-16 (little endian, with
 * BOM) is decoded; compressed or binary content throws with a message that says what the file really is.
 */
export function readTextFile(file: string): { text: string; bom: boolean; encoding: TextEncoding } {
  const bytes = fs.readFileSync(file);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) throw new Error('the file is gzip-compressed, not plain XML; save it uncompressed in ECU-TEST');
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) throw new Error('the file is a zip archive, not plain XML; save it uncompressed in ECU-TEST');
  const encoding: TextEncoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) throw new Error('UTF-16 big endian files are not supported; save the file as UTF-8');
  const raw = bytes.toString(encoding);
  const bom = raw.charCodeAt(0) === 0xfeff;
  return { text: bom ? raw.slice(1) : raw, bom, encoding };
}

/** Apply a plan on disk (CLI/MCP). Returns the files touched. */
export function applyPlanToDisk(plan: EditPlan): string[] {
  const touched: string[] = [];
  for (const c of plan.creates) {
    fs.mkdirSync(path.dirname(c.file), { recursive: true });
    fs.writeFileSync(c.file, c.content, 'utf8');
    touched.push(c.file);
  }
  for (const [file, edits] of groupByFile(plan.edits)) {
    const { text, bom, encoding } = readTextFile(file);
    fs.writeFileSync(file, (bom ? BOM : '') + applyEdits(text, edits), encoding);
    if (!touched.includes(file)) touched.push(file);
  }
  return touched;
}
