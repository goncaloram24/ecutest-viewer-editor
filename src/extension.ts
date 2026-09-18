// VS Code activation and command registration. All logic lives in src/core (shared with the CLI and MCP server).
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { describe, renderDescription } from './core/describe';
import { EditPlan } from './core/edit';
import { nodeView } from './core/json';
import { XNode } from './core/model';
import { addPackage, addParam, addStep, deleteNode, moveNode, newProject, rename, setValue } from './core/ops';
import { allowedStepTypes, allowedValues, stepType } from './core/schema';
import { Workspace } from './core/workspace';
import { DescriptionView } from './vscode/descriptionView';
import { EditorPanel } from './vscode/editorPanel';
import { ModelService } from './vscode/modelService';
import { TestsTreeProvider } from './vscode/treeProvider';

const DEV_COMMAND_DELAY_MS = 6000;

export function activate(context: vscode.ExtensionContext): void {
  const model = new ModelService();
  const tree = new TestsTreeProvider(model);
  const treeView = vscode.window.createTreeView('ecutest.tests', { treeDataProvider: tree, showCollapseAll: true });
  const description = new DescriptionView(model, context.extensionUri);
  const editor = new EditorPanel(model, context.extensionUri, (node) => description.show(node));
  context.subscriptions.push(model, treeView, vscode.window.registerFileDecorationProvider(tree), vscode.window.registerWebviewViewProvider('ecutest.description', description));
  treeView.onDidChangeSelection((e) => e.selection[0] && description.show(e.selection[0]));

  const workspace = (): Workspace => {
    if (!model.ws) throw new Error('No workspace folder is open');
    return model.ws;
  };

  /** Commands accept a tree node, a path string, or nothing (→ current editor element, tree selection, or a picker). */
  const target = async (arg: unknown, filter: (n: XNode) => boolean = () => true, placeHolder = 'Select an element'): Promise<XNode | undefined> => {
    const ws = workspace();
    if (typeof arg === 'string') return ws.resolve(arg);
    // Invoked on a .prj/.pkg file (explorer or editor title): the project, or the first test case using the package.
    if (arg && typeof arg === 'object' && 'fsPath' in arg) {
      const uri = arg as vscode.Uri;
      const file = path.normalize(uri.fsPath).toLowerCase();
      const same = (f: string | undefined) => !!f && path.normalize(f).toLowerCase() === file;
      const node = ws.all().find((n) => (n.kind === 'project' && same(n.file)) || (n.kind === 'packageRef' && same(n.pkg?.file)) || (n.kind === 'package' && same(n.file)));
      if (!node) throw new Error(`${path.basename(uri.fsPath)} is not loaded: no project under ${ws.opts.root} references it (see "ECU-TEST: Show Output" for what was loaded)`);
      return node;
    }
    if (arg && typeof arg === 'object' && 'navChildren' in arg) return ws.get((arg as XNode).path) ?? (arg as XNode);
    const current = (editor.currentPath && ws.get(editor.currentPath)) || treeView.selection[0];
    if (current && filter(current)) return current;
    const pick = await vscode.window.showQuickPick(ws.all().filter(filter).map((n) => ({ label: n.name, description: n.path, detail: n.value, node: n })), { placeHolder, matchOnDescription: true, matchOnDetail: true });
    return pick?.node;
  };

  const ask = (prompt: string, value = '', validate?: (v: string) => string | undefined) => vscode.window.showInputBox({ prompt, value, validateInput: validate });

  const register = (name: string, run: (arg?: unknown) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(`ecutest.${name}`, async (arg?: unknown) => {
        try {
          const result = await run(arg);
          if (result && typeof result === 'object' && 'edits' in result) await model.applyPlan(result as EditPlan);
        } catch (e) {
          void vscode.window.showErrorMessage(`ECU-TEST: ${(e as Error).message}`);
        }
      }),
    );

  register('refresh', () => model.reload('manual refresh'));
  register('showOutput', () => model.output.show(true));
  register('open', async (arg) => {
    const node = await target(arg);
    if (node) editor.open(node);
  });
  register('search', async () => {
    const node = await target(undefined, () => true, 'Search by name, value, type or path');
    if (node) await vscode.commands.executeCommand(model.config<boolean>('openInEditor') ? 'ecutest.open' : 'ecutest.revealInSource', node);
  });
  register('reveal', async (arg) => {
    const node = await target(arg);
    if (node) await treeView.reveal(node, { select: true, focus: true, expand: true });
  });
  register('revealInSource', async (arg) => {
    const node = await target(arg);
    if (!node) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(node.file));
    const start = doc.positionAt(node.start);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(start, start), viewColumn: vscode.ViewColumn.Beside, preserveFocus: false });
  });
  register('copyJson', async (arg) => {
    const node = await target(arg);
    if (!node) return;
    await vscode.env.clipboard.writeText(JSON.stringify(nodeView(workspace(), node, 2), null, 2));
    void vscode.window.setStatusBarMessage(`Copied ${node.path} as JSON`, 3000);
  });
  register('describe', async (arg) => {
    const node = await target(arg);
    if (!node) return;
    description.show(node);
    await vscode.commands.executeCommand('ecutest.description.focus');
    model.output.appendLine(renderDescription(describe(workspace(), node)));
  });
  register('setValue', async (arg) => {
    const node = await target(arg, (n) => !!n.valueRef || n.kind === 'parameter', 'Element to set');
    if (!node) return undefined;
    const allowed = node.valueRef && allowedValues(node.valueRef);
    const value = allowed ? await vscode.window.showQuickPick(allowed, { placeHolder: `Value of ${node.path}` }) : await ask(`Value of ${node.path}`, node.value ?? '');
    return value === undefined ? undefined : setValue(workspace(), node.path, value);
  });
  register('addStep', async (arg) => {
    const parent = await target(arg, (n) => allowedStepTypes(n).length > 0, 'Package or container step to add to');
    if (!parent) return undefined;
    const pick = await vscode.window.showQuickPick(allowedStepTypes(parent).map((label) => ({ label, description: stepType(label)!.title, detail: stepType(label)!.doc })), { placeHolder: `Step type to add to ${parent.path}` });
    const type = pick && stepType(pick.label)!;
    if (!type) return undefined;
    const name = type.nameDoc ? await ask(`${type.title}: ${type.nameDoc}`) : undefined;
    const value = type.valueDoc ? await ask(`${type.title}: ${type.valueDoc}`) : undefined;
    if ((type.nameDoc && name === undefined) || (type.valueDoc && value === undefined)) return undefined;
    return addStep(workspace(), parent.path, type.label, { name: name || undefined, value: value || undefined });
  });
  register('addParam', async (arg) => {
    const pkg = await target(arg, (n) => (n.kind === 'packageRef' && !!n.pkg) || n.kind === 'package', 'Package to add a variable to');
    const name = pkg && (await ask('Variable name'));
    const value = name ? await ask(`Default value of ${name}`) : undefined;
    const direction = value !== undefined ? await vscode.window.showQuickPick(['in', 'out', 'local'], { placeHolder: 'Direction: in = parameter, out = return value, local = variable' }) : undefined;
    return pkg && name && value !== undefined && direction ? addParam(workspace(), pkg.path, name, value, direction as 'in' | 'out' | 'local') : undefined;
  });
  register('addPackage', async (arg) => {
    const parent = await target(arg, (n) => n.kind === 'project' || n.kind === 'folder', 'Project or folder to add the package to');
    const file = parent && (await ask('Package file relative to the project folder (created if it does not exist)', 'New.pkg'));
    return parent && file ? addPackage(workspace(), parent.path, file) : undefined;
  });
  register('rename', async (arg) => {
    const node = await target(arg);
    const name = node && (await ask(`New name of ${node.path}`, node.name));
    return node && name ? rename(workspace(), node.path, name) : undefined;
  });
  register('delete', async (arg) => {
    const node = await target(arg);
    if (!node) return undefined;
    const plan = deleteNode(workspace(), node.path);
    const ok = await vscode.window.showWarningMessage(`${plan.summary}?`, { modal: true }, 'Delete');
    return ok ? plan : undefined;
  });
  register('move', async (arg) => {
    const node = await target(arg);
    if (!node) return undefined;
    const after = await target(undefined, (n) => n !== node && n.kind === node.kind && n.tag === node.tag && n.file === node.file && !n.path.startsWith(node.path + '/'), `Move ${node.name} after…`);
    return after && after !== node ? moveNode(workspace(), node.path, { after: after.path }) : undefined;
  });
  register('newProject', async () => {
    const file = await ask('Project file relative to the workspace folder', 'New.prj');
    return file ? newProject(workspace(), file) : undefined;
  });
  register('toggleGeneratedView', async () => {
    const config = vscode.workspace.getConfiguration('ecutest');
    await config.update('showGenerated', !config.get<boolean>('showGenerated'), vscode.ConfigurationTarget.Workspace);
  });
  register('setupMcp', async () => {
    const root = workspace().opts.root;
    const file = path.join(root, '.mcp.json');
    const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const generatedDir = model.config<string>('generatedDir');
    // Absolute path of the MCP server bundled inside this installed extension.
    const args = [context.asAbsolutePath(path.join('dist', 'mcp.js')), '--root', root, ...(generatedDir ? ['--generated-dir', generatedDir] : [])];
    existing.mcpServers = { ...existing.mcpServers, ecutest: { command: 'node', args } };
    fs.writeFileSync(file, JSON.stringify(existing, null, 2) + '\n');
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    void vscode.window.showInformationMessage('ECU-TEST: wrote .mcp.json. Agents such as Claude Code pick up the "ecutest" server from this folder.');
  });

  model.reload('startup');
  if (model.config<boolean>('focusOnStartup') && model.ws?.projects.length) void vscode.commands.executeCommand('ecutest.tests.focus');
  const startupPath = model.config<string>('startupPath');
  if (startupPath && model.ws?.get(startupPath)) void vscode.commands.executeCommand('ecutest.open', startupPath);

  // Automated UI testing: ECUTEST_DEV_COMMANDS="cmd1,cmd2" runs the commands after activation.
  const dev = (process.env.ECUTEST_DEV_COMMANDS ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  if (dev.length) {
    const timer = setTimeout(async () => {
      for (const c of dev) await vscode.commands.executeCommand(c).then(undefined, (e) => model.output.appendLine(`dev command ${c} failed: ${e}`));
    }, DEV_COMMAND_DELAY_MS);
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  }
}

export function deactivate(): void {}
