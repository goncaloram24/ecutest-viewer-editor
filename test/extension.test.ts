// Activation smoke test with a stubbed `vscode` module: commands register, the tree is populated,
// problems are reported once, and the output panel is never revealed automatically.
import { describe as suite, expect, it, vi } from 'vitest';
import { EXAMPLE, withCopy } from './helpers';

const state = vi.hoisted(() => ({ root: '', shown: 0, warnings: [] as string[], commands: new Map<string, (...a: unknown[]) => unknown>(), tree: undefined as any, settings: {} as Record<string, unknown> }));

vi.mock('vscode', () => {
  class EventEmitter<T> {
    private listeners: ((e: T) => void)[] = [];
    event = (l: (e: T) => void) => (this.listeners.push(l), { dispose() {} });
    fire(e: T) {
      this.listeners.forEach((l) => l(e));
    }
    dispose() {}
  }
  const disposable = () => ({ dispose() {} });
  const Uri = { file: (f: string) => ({ fsPath: f, scheme: 'file', path: f }), from: (c: object) => c, joinPath: (b: object, ...p: string[]) => ({ ...b, extra: p }) };
  return {
    EventEmitter,
    Uri,
    TreeItem: class {
      constructor(public label: string, public collapsibleState: number) {}
    },
    ThemeIcon: class {
      constructor(public id: string) {}
    },
    ThemeColor: class {
      constructor(public id: string) {}
    },
    MarkdownString: class {
      constructor(public value: string) {}
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ConfigurationTarget: { Workspace: 2 },
    ViewColumn: { Active: -1, Beside: -2 },
    window: {
      createOutputChannel: () => ({ appendLine() {}, show: () => state.shown++, dispose() {} }),
      createTreeView: (_id: string, opts: { treeDataProvider: unknown }) => ((state.tree = opts.treeDataProvider), { selection: [], onDidChangeSelection: disposable, reveal: async () => {}, dispose() {} }),
      registerFileDecorationProvider: disposable,
      registerWebviewViewProvider: disposable,
      showWarningMessage: (m: string) => (state.warnings.push(m), Promise.resolve(undefined)),
      showErrorMessage: (m: string) => Promise.reject(new Error(m)),
    },
    workspace: {
      get workspaceFolders() {
        return [{ uri: Uri.file(state.root) }];
      },
      createFileSystemWatcher: () => ({ onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable, dispose() {} }),
      onDidSaveTextDocument: disposable,
      onDidChangeConfiguration: disposable,
      onDidChangeWorkspaceFolders: disposable,
      getConfiguration: () => ({ get: (k: string) => state.settings[k] }),
      asRelativePath: (f: string) => f,
    },
    commands: { registerCommand: (id: string, fn: (...a: unknown[]) => unknown) => (state.commands.set(id, fn), disposable()), executeCommand: async (id: string, ...a: unknown[]) => state.commands.get(id)?.(...a) },
  };
});

suite('extension activation', () => {
  it('registers all contributed commands, fills the tree and stays quiet', () =>
    withCopy(EXAMPLE, async (dir) => {
      state.root = dir;
      state.settings = { openInEditor: true, showGenerated: true, generatedDir: 'gen', packageBaseDirs: [], projectGlob: '**/*.prj', project: '' };
      const { activate } = await import('../src/extension');
      const subscriptions: { dispose(): void }[] = [];
      activate({ subscriptions, extensionUri: {}, asAbsolutePath: (p: string) => p } as never);
      const manifest = (await import('../package.json')).default as { contributes: { commands: { command: string }[] } };
      expect([...state.commands.keys()].sort()).toEqual(manifest.contributes.commands.map((c) => c.command).sort());

      const roots = state.tree.getChildren();
      expect(roots.map((r: { path: string }) => r.path)).toEqual(['/BodyControl']);
      const lights = state.tree.getChildren(roots[0])[0];
      const item = state.tree.getTreeItem(state.tree.getChildren(lights)[3]);
      expect(item).toMatchObject({ label: 'Fog light', description: 'missing: Lights\\FogLight.pkg', contextValue: expect.stringContaining('removable') });
      expect(state.tree.provideFileDecoration({ scheme: 'ecutest', path: '/BodyControl/Lights/FogLight' }).badge).toBe('!');
      expect(state.tree.provideFileDecoration({ scheme: 'ecutest', path: '/BodyControl' }).badge).toBe('·');

      await state.commands.get('ecutest.refresh')!();
      await state.commands.get('ecutest.refresh')!();
      expect(state.warnings).toHaveLength(1);
      expect(state.warnings[0]).toMatch(/Missing package/);
      expect(state.shown).toBe(0);
      await state.commands.get('ecutest.showOutput')!();
      expect(state.shown).toBe(1);
      subscriptions.forEach((s) => s.dispose());
    }));
});
