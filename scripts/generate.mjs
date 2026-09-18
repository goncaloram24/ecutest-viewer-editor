// Dummy stand-in for the real test.h generator. Usage: node scripts/generate.mjs <root> [<out dir>]
// Emits <out dir>/test.h with one `void TC_<package>_<case>(void)` per test case, using the shared core.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// In the repo the core bundle is ../dist/core.js; in the release zip it sits next to this script.
const corePath = [path.join(here, 'core.js'), path.join(here, '..', 'dist', 'core.js')].find((f) => fs.existsSync(f));
if (!corePath) throw new Error('core.js not found: run `npm run build` first');
const core = createRequire(import.meta.url)(corePath);

const root = path.resolve(process.argv[2] ?? '.');
const outDir = path.resolve(process.argv[3] ?? path.join(root, 'gen'));
const ws = core.Workspace.load({ root });
for (const d of ws.diagnostics) console.warn(`${d.severity}: ${path.relative(root, d.file)}:${d.line}: ${d.message}`);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'test.h'), core.renderHeaderFor(ws), 'utf8');
console.log(`wrote ${path.join(outDir, 'test.h')} (${core.generateModel(ws).length} test cases)`);
