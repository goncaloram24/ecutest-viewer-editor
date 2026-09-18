// Release zip: .vsix + standalone tools (mcp/cli/core + dummy generator) + example project + docs.
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { name, version } = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const run = (cmd, cwd = repo) => execSync(cmd, { cwd, stdio: 'inherit' });

run('npm run typecheck');
run('npm run build');
run('npx vsce package --allow-missing-repository --readme-path INSTALL.md');

const stage = path.join(repo, 'release', `${name}-${version}`);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'tools'), { recursive: true });
fs.copyFileSync(path.join(repo, `${name}-${version}.vsix`), path.join(stage, `${name}-${version}.vsix`));
for (const f of ['mcp.js', 'cli.js', 'core.js']) fs.copyFileSync(path.join(repo, 'dist', f), path.join(stage, 'tools', f));
// generate.mjs imports ./core.js when it sits next to it (tools/), ../dist/core.js in the repo.
fs.copyFileSync(path.join(repo, 'scripts', 'generate.mjs'), path.join(stage, 'tools', 'generate.mjs'));
fs.cpSync(path.join(repo, 'fixtures', 'example'), path.join(stage, 'example'), { recursive: true });
fs.writeFileSync(
  path.join(stage, 'example', '.mcp.json'),
  JSON.stringify({ mcpServers: { ecutest: { command: 'node', args: ['../tools/mcp.js', '--root', '.', '--generated-dir', 'gen'] } } }, null, 2) + '\n',
);
for (const f of ['INSTALL.md', 'README.md', 'LICENSE']) fs.copyFileSync(path.join(repo, f), path.join(stage, f));

const zip = `${name}-${version}.zip`;
fs.rmSync(path.join(repo, 'release', zip), { force: true });
run(`zip -qr ${zip} ${name}-${version}`, path.join(repo, 'release'));
console.log(`release/${zip}`);
