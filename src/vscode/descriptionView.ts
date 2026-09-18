// "Description" webview view: the describe output of the selected element, with links to referenced paths.
import * as vscode from 'vscode';
import { describe } from '../core/describe';
import { generateModel } from '../core/generate';
import { XNode } from '../core/model';
import { ModelService } from './modelService';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class DescriptionView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private path?: string;

  constructor(private readonly model: ModelService, private readonly extensionUri: vscode.Uri) {
    model.onDidChange(() => this.render());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    view.webview.onDidReceiveMessage((m: { open?: string; source?: string }) => {
      if (m.open) void vscode.commands.executeCommand('ecutest.open', m.open);
      if (m.source) void vscode.commands.executeCommand('ecutest.revealInSource', m.source);
    });
    this.render();
  }

  show(node: XNode): void {
    this.path = node.path;
    this.render();
  }

  private render(): void {
    if (!this.view) return;
    const ws = this.model.ws;
    const node = this.path ? ws?.get(this.path) : undefined;
    const css = this.view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'description.css'));
    const nonce = Math.random().toString(36).slice(2);
    let body = '<p class="hint">Select an element in the Tests tree.</p>';
    if (ws && node) {
      const d = describe(ws, node);
      const link = (p: string, label = p) => `<a href="#" data-open="${esc(p)}">${esc(label)}</a>`;
      const list = (items: string[]) => (items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>` : '');
      const diff = this.model.diff.get(node.path);
      const code = this.model.config<boolean>('showGenerated') ? generateModel(ws, node).slice(0, 5).map((c) => `<pre>${esc(c.text)}</pre>`).join('') : '';
      body = `<h2>${esc(d.title)}</h2>
        <p class="path">${link(d.path)} · <a href="#" data-source="${esc(d.path)}">${esc(d.source)}</a></p>
        <p>${esc(d.what)}</p>${list(d.details.map(esc))}
        ${d.generated.length ? `<h3>test.h</h3>${list(d.generated.map(esc))}` : ''}
        ${diff ? `<p class="diff">Generated output is ${esc(diff.status)}: ${esc(diff.detail)}</p>` : ''}${code}
        ${d.references.length ? `<h3>References</h3>${list(d.references.map((r) => `${esc(r.label)}: ${link(r.path)}`))}` : ''}`;
    }
    this.view.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.view.webview.cspSource}; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${css}"></head><body>${body}
      <script nonce="${nonce}">const vscode = acquireVsCodeApi();
        document.addEventListener('click', (e) => { const a = e.target.closest('a'); if (!a) return; e.preventDefault();
          if (a.dataset.open) vscode.postMessage({ open: a.dataset.open }); if (a.dataset.source) vscode.postMessage({ source: a.dataset.source }); });
      </script></body></html>`;
  }
}
