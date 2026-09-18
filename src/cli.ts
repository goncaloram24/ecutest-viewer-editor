// CLI over the core. Usage: ecutest --root <dir> <command> [args] [--option value] [--dry-run] [--json]
import { COMMANDS, findCommand, PATH_DOC } from './core/api';
import { Workspace } from './core/workspace';

const GLOBAL = new Set(['root', 'project', 'generatedDir', 'projectGlob', 'packageBaseDirs', 'json', 'help']);
const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function usage(): string {
  const lines = ['Usage: ecutest [--root <dir>] [--project <name>] [--generated-dir <dir>] <command> [args]', '', PATH_DOC, '', 'Commands:'];
  for (const c of COMMANDS) {
    const pos = c.params.filter((p) => p.positional).map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`));
    const opt = c.params.filter((p) => !p.positional).map((p) => `[--${p.name.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}${p.type === 'boolean' ? '' : ' <v>'}]`);
    lines.push(`  ${[c.name, ...pos, ...opt].join(' ')}`, `      ${c.description}`);
  }
  return lines.join('\n');
}

function main(argv: string[]): number {
  const options: Record<string, any> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--') || arg === '--') {
      positional.push(arg);
      continue;
    }
    const [rawKey, inline] = arg.slice(2).split(/=(.*)/s);
    const key = camel(rawKey);
    const boolean = key === 'dryRun' || key === 'json' || key === 'help';
    options[key] = boolean ? true : inline ?? argv[++i];
  }
  const [name, ...rest] = positional;
  const command = name ? findCommand(name) : undefined;
  if (options.help || !command) {
    console.log(usage());
    return name && !command ? 2 : 0;
  }
  const args: Record<string, any> = {};
  const slots = command.params.filter((p) => p.positional);
  rest.forEach((v, i) => slots[i] && (args[slots[i].name] = v));
  for (const p of command.params) {
    if (options[p.name] !== undefined) args[p.name] = p.type === 'number' ? Number(options[p.name]) : options[p.name];
    if (p.required && args[p.name] === undefined) throw new Error(`Missing <${p.name}> for ${command.name}: ${p.doc}`);
  }
  const unknown = Object.keys(options).filter((k) => !GLOBAL.has(k) && !command.params.some((p) => p.name === k));
  if (unknown.length) throw new Error(`Unknown option(s) for ${command.name}: ${unknown.map((k) => '--' + k).join(', ')}`);
  const ws = Workspace.load({
    root: options.root ?? process.cwd(),
    project: options.project,
    projectGlob: options.projectGlob,
    packageBaseDirs: options.packageBaseDirs ? String(options.packageBaseDirs).split(',') : undefined,
  });
  const result = command.run(ws, args, { generatedDir: options.generatedDir });
  console.log(typeof result === 'string' && !options.json ? result : JSON.stringify(result, null, 2));
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
}
