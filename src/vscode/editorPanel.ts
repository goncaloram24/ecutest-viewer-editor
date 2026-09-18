// Visual editor webview: shows one element with editable fields, its children (add/delete/move) and a
// navigation bar. All changes go through core ops → ModelService.applyPlan (undo-able WorkspaceEdit).
import * as vscode from 'vscode';
import { describe } from '../core/describe';
import { EditPlan } from '../core/edit';
import { nodeView } from '../core/json';
import { XNode } from '../core/model';
import { addPackage, addParam, addStep, deleteNode, moveNode, rename, setValue } from '../core/ops';
import { nameRefs, schemaFor } from '../core/schema';
import { Workspace } from '../core/workspace';
import { ModelService } from './modelService';
import { contextOf } from './treeProvider';

type Message =
  | { type: 'navigate'; path: string }
  | { type: 'back' | 'forward' | 'source' | 'reveal' }
  | { type: 'set'; target: string; value: string }
  | { type: 'rename'; name: string }
  | { type: 'addStep'; stepType: string; name?: string; value?: string }
  | { type: 'addParam'; name: string; value: string; direction: 'in' | 'out' | 'local' }
  | { type: 'addPackage'; file: string; name?: string }
  | { type: 'delete' | 'moveUp' | 'moveDown'; path: string };

export class EditorPanel {
  private panel?: vscode.WebviewPanel;
  private history: string[] = [];
  private cursor = -1;
  /** File/offset of the shown element, to find it again after an edit changed its path (rename). */
  private anchor?: { file: string; start: number };

  constructor(private readonly model: ModelService, private readonly extensionUri: vscode.Uri, private readonly onShow: (node: XNode) => void) {
    model.onDidChange(() => this.render());
  }

  get currentPath(): string | undefined {
    return this.panel ? this.history[this.cursor] : undefined;
  }

  open(node: XNode): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('ecutest.editor', 'ECU-TEST', { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] });
      this.panel.onDidDispose(() => (this.panel = undefined));
      this.panel.webview.onDidReceiveMessage((m: Message) => void this.handle(m));
      this.panel.webview.html = this.html(this.panel.webview);
    }
    if (this.history[this.cursor] !== node.path) {
      this.history = [...this.history.slice(0, this.cursor + 1), node.path].slice(-100);
      this.cursor = this.history.length - 1;
    }
    this.panel.reveal(undefined, false);
    this.render();
  }

  private html(webview: vscode.Webview): string {
    const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', f));
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
      <link rel="stylesheet" href="${uri('editor.css')}"></head><body><div id="app"></div><script src="${uri('editor.js')}"></script></body></html>`;
  }

  private current(ws: Workspace): XNode | undefined {
    const byPath = ws.get(this.history[this.cursor] ?? '');
    const found = byPath ?? (this.anchor && ws.all().find((n) => n.file === this.anchor!.file && n.start === this.anchor!.start));
    if (found && found.path !== this.history[this.cursor]) this.history[this.cursor] = found.path;
    return found;
  }

  private render(): void {
    const ws = this.model.ws;
    if (!this.panel || !ws) return;
    let node = this.current(ws);
    // The element is gone (deleted, file removed): fall back to the closest existing ancestor.
    for (let p = this.history[this.cursor]; !node && p?.includes('/'); ) node = ws.get((p = p.slice(0, p.lastIndexOf('/'))));
    node ??= ws.roots()[0];
    if (!node) return void this.panel.webview.postMessage({ type: 'empty' });
    this.history[this.cursor] = node.path;
    this.anchor = { file: node.file, start: node.start };
    this.panel.title = node.name;
    const siblings = node.navParent?.navChildren ?? ws.roots();
    const i = siblings.indexOf(node);
    const sameKind = (a: XNode | undefined, b: XNode) => !!a && a.kind === b.kind && a.tag === b.tag;
    void this.panel.webview.postMessage({
      type: 'render',
      view: nodeView(ws, node, 0),
      schema: schemaFor(node),
      description: describe(ws, node),
      renamable: nameRefs(node).length > 0,
      context: contextOf(node),
      generated: this.model.diff.get(node.path),
      children: node.navChildren.map((c, n, all) => ({ path: c.path, name: c.name, type: c.label ?? c.kind, value: c.value, kind: c.kind, removable: contextOf(c).includes('removable'), canUp: sameKind(all[n - 1], c), canDown: sameKind(all[n + 1], c), missing: c.kind === 'packageRef' && !c.pkg })),
      nav: { canBack: this.cursor > 0, canForward: this.cursor < this.history.length - 1, parent: node.navParent?.path, prev: siblings[i - 1]?.path, next: siblings[i + 1]?.path, firstChild: node.navChildren[0]?.path },
    });
    this.onShow(node);
  }

  private async handle(m: Message): Promise<void> {
    const ws = this.model.ws;
    const path = this.history[this.cursor];
    if (!ws || !path) return;
    try {
      const plan = this.plan(ws, path, m);
      if (plan) await this.model.applyPlan(plan);
    } catch (e) {
      void vscode.window.showErrorMessage(`ECU-TEST: ${(e as Error).message}`);
      this.render();
    }
  }

  private plan(ws: Workspace, path: string, m: Message): EditPlan | undefined {
    const sibling = (p: string, offset: number) => {
      const node = ws.resolve(p);
      const all = node.navParent?.navChildren ?? [];
      return all[all.indexOf(node) + offset]?.path;
    };
    switch (m.type) {
      case 'navigate':
        return void this.open(ws.resolve(m.path));
      case 'back':
      case 'forward':
        this.cursor = Math.max(0, Math.min(this.history.length - 1, this.cursor + (m.type === 'back' ? -1 : 1)));
        return void this.render();
      case 'source':
        return void vscode.commands.executeCommand('ecutest.revealInSource', path);
      case 'reveal':
        return void vscode.commands.executeCommand('ecutest.reveal', path);
      case 'set':
        return setValue(ws, m.target, m.value);
      case 'rename':
        return rename(ws, path, m.name);
      case 'addStep':
        return addStep(ws, path, m.stepType, { name: m.name || undefined, value: m.value || undefined });
      case 'addParam':
        return addParam(ws, path, m.name, m.value, m.direction);
      case 'addPackage':
        return addPackage(ws, path, m.file, m.name || undefined);
      case 'delete':
        return deleteNode(ws, m.path);
      case 'moveUp':
        return moveNode(ws, m.path, { before: sibling(m.path, -1) });
      case 'moveDown':
        return moveNode(ws, m.path, { after: sibling(m.path, 1) });
    }
  }
}
