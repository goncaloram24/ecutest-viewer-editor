// MCP server (stdio) over the core. Usage: node dist/mcp.js --root <dir> [--generated-dir <dir>] [--project <name>]
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { COMMANDS, PATH_DOC } from './core/api';
import { Workspace } from './core/workspace';

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const INSTRUCTIONS = [
  'Tools for navigating and editing tracetronic ECU-TEST projects (.prj) and packages (.pkg).',
  'Workflow: 1) start with ecutest_info; 2) navigate with ecutest_tree / ecutest_search; 3) read with ecutest_get and ecutest_describe;',
  '4) check ecutest_schema before adding or setting anything; 5) edit with the write tools (use dryRun to preview the text edits).',
  'NEVER read, grep or edit the .prj/.pkg XML text directly: the files are large, offset-sensitive and must stay loadable by ECU-TEST.',
  PATH_DOC,
].join('\n');

async function main(): Promise<void> {
  const opts = { root: option('root') ?? process.cwd(), project: option('project') };
  const ctx = { generatedDir: option('generated-dir') };
  const server = new McpServer({ name: 'ecutest', version: '0.1.2' }, { instructions: INSTRUCTIONS });
  for (const command of COMMANDS) {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const p of command.params) {
      const base = p.type === 'number' ? z.number() : p.type === 'boolean' ? z.boolean() : z.string();
      shape[p.name] = (p.required ? base : base.optional()).describe(p.doc);
    }
    server.tool(command.tool, command.description, shape, async (args: Record<string, unknown>) => {
      try {
        // Reload per call: files may have been changed by ECU-TEST, the editor or git in the meantime.
        const result = command.run(Workspace.load(opts), args, ctx);
        return { content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: `error: ${(e as Error).message}` }] };
      }
    });
  }
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
