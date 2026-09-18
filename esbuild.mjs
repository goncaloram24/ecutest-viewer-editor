// Builds the four bundles: extension (cjs, vscode external), cli, mcp, core.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const common = { bundle: true, platform: 'node', target: 'node18', sourcemap: true, logLevel: 'info' };
const node = { js: '#!/usr/bin/env node' };
const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', format: 'cjs', external: ['vscode'] },
  { ...common, entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js', format: 'cjs', banner: node },
  { ...common, entryPoints: ['src/mcp.ts'], outfile: 'dist/mcp.js', format: 'cjs', banner: node },
  { ...common, entryPoints: ['src/index.ts'], outfile: 'dist/core.js', format: 'cjs' },
];

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
