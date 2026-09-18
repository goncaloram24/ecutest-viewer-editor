import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe as suite, expect, it } from 'vitest';
import { COMMANDS } from '../src/core/api';
import { EXAMPLE, REPO, withCopy } from './helpers';

const LOW = '/BodyControl/Lights/LowBeam';

suite('MCP server over stdio', () => {
  it('lists every tool and serves each one once', () =>
    withCopy(EXAMPLE, async (dir) => {
      const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(REPO, 'dist', 'mcp.js'), '--root', dir, '--generated-dir', 'gen'] });
      const client = new Client({ name: 'test', version: '0' });
      await client.connect(transport);
      try {
        expect(client.getInstructions()).toMatch(/start with ecutest_info/);
        const tools = (await client.listTools()).tools;
        expect(tools.map((t) => t.name).sort()).toEqual(COMMANDS.map((c) => c.tool).sort());
        expect(tools).toHaveLength(16);
        for (const t of tools) expect(t.description!.length).toBeGreaterThan(40);

        const call = async (name: string, args: Record<string, unknown> = {}) => {
          const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
          return { error: !!res.isError, text: res.content[0].text };
        };
        const json = async (name: string, args: Record<string, unknown> = {}) => {
          const res = await call(name, args);
          expect(res.error, res.text).toBe(false);
          return JSON.parse(res.text);
        };

        const info = await json('ecutest_info');
        expect(info.projects[0].path).toBe('/BodyControl');
        expect(info.diagnostics[0].message).toMatch(/Missing package/);
        expect((await call('ecutest_tree', { path: LOW, depth: 1 })).text).toContain('settleTime [parameter] = 0.5');
        expect((await json('ecutest_get', { path: `${LOW}/settleTime` })).value).toBe('0.5');
        expect((await json('ecutest_search', { text: 'IGN_STATE' })).length).toBeGreaterThan(0);
        expect((await json('ecutest_schema', { path: LOW })).allowedChildren.map((c: { type: string }) => c.type)).toContain('TsBlock');
        expect((await call('ecutest_describe', { path: `${LOW}/Switch on` })).text).toContain('TC_LowBeam_Switch_on');
        expect((await call('ecutest_generate_preview', { path: `${LOW}/Switch on` })).text).toContain('void TC_LowBeam_Switch_on(void)');
        expect((await json('ecutest_diff')).upToDate).toBe(true);

        const dry = await json('ecutest_set_value', { path: `${LOW}/settleTime`, value: '2.5', dryRun: true });
        expect(dry).toMatchObject({ applied: false, edits: [{ file: 'Lights/LowBeam.pkg', text: '2.5' }] });
        expect((await json('ecutest_get', { path: `${LOW}/settleTime` })).value).toBe('0.5');
        expect((await json('ecutest_set_value', { path: `${LOW}/settleTime`, value: '2.5' })).applied).toBe(true);
        expect((await json('ecutest_get', { path: `${LOW}/settleTime` })).value).toBe('2.5');
        const bad = await call('ecutest_set_value', { path: `${LOW}/settleTime`, value: 'later' });
        expect(bad).toMatchObject({ error: true, text: expect.stringMatching(/not a number/) });

        await json('ecutest_add_step', { parent: `${LOW}/Switch on`, type: 'TsWait', value: '3' });
        await json('ecutest_add_param', { package: LOW, name: 'retries', value: '2' });
        await json('ecutest_add_package', { project: '/BodyControl', file: 'Extra/New.pkg' });
        await json('ecutest_rename', { path: `${LOW}/retries`, name: 'attempts' });
        await json('ecutest_move', { path: `${LOW}/attempts`, before: `${LOW}/settleTime` });
        await json('ecutest_delete', { path: `${LOW}/Switch off` });
        await json('ecutest_new_project', { file: 'Second.prj' });
        const after = await json('ecutest_info');
        expect(after.projects.map((p: { path: string }) => p.path)).toEqual(['/BodyControl', '/Second']);
        const tree = (await call('ecutest_tree', { path: LOW, depth: 1 })).text.split('\n');
        expect(tree[1]).toBe('  attempts [parameter] = 2');
        expect(tree.join('\n')).not.toContain('Switch off');
        const diff = await json('ecutest_diff');
        expect(diff.differences.map((d: { status: string }) => d.status).sort()).toEqual(['changed', 'extra', 'missing']);
      } finally {
        await client.close();
      }
    }), 30000);
});
