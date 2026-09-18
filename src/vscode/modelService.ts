// Owns the loaded model: configuration, (re)loading, file watching, the output channel and applying edit plans
// through undo-able WorkspaceEdits.
import * as path from 'path';
import * as vscode from 'vscode';
import { DiffEntry, diffGenerated } from '../core/diff';
import { EditPlan, groupByFile } from '../core/edit';
import { XNode } from '../core/model';
import { Workspace } from '../core/workspace';

const DEBOUNCE_MS = 300;

export class ModelService implements vscode.Disposable {
  ws?: Workspace;
  /** Differences to the generated folder by element path (only while showGenerated is on). */
  diff = new Map<string, DiffEntry>();
  /** Paths with diagnostics or generated differences, including their ancestors (for tree badges). */
  marks = new Map<string, 'problem' | 'generated'>();
  readonly output = vscode.window.createOutputChannel('ECU-TEST');
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.output, this.changed];
  private readonly reported = new Set<string>();
  private pending = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{prj,pkg}');
    const onFile = (uri: vscode.Uri) => this.schedule(uri.fsPath);
    this.disposables.push(
      watcher,
      watcher.onDidChange(onFile),
      watcher.onDidCreate(onFile),
      watcher.onDidDelete(onFile),
      // Saves of any other file type are ignored.
      vscode.workspace.onDidSaveTextDocument((doc) => /\.(prj|pkg)$/i.test(doc.fileName) && this.schedule(doc.fileName)),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('ecutest') && this.reload('configuration changed')),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.reload('workspace folders changed')),
    );
  }

  get root(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  config<T>(key: string): T {
    return vscode.workspace.getConfiguration('ecutest').get<T>(key) as T;
  }

  reload(reason: string): void {
    const root = this.root;
    if (!root) {
      this.ws = undefined;
      this.changed.fire();
      return;
    }
    this.ws = Workspace.load({
      root,
      projectGlob: this.config<string>('projectGlob') || undefined,
      project: this.config<string>('project') || undefined,
      packageBaseDirs: this.config<string[]>('packageBaseDirs'),
      ignoreGlobs: this.config<string[]>('ignoreGlobs'),
    });
    this.afterLoad(`Loaded (${reason})`);
  }

  private schedule(file: string): void {
    this.pending.add(file);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const files = [...this.pending];
      this.pending = new Set();
      if (!this.ws) return this.reload('files changed');
      // A loaded .pkg is re-indexed alone, a .prj reloads its project; anything unknown may be a new reference target.
      const results = files.map((f) => this.ws!.reloadFile(f));
      if (results.includes('none')) this.reload(`${files.map((f) => path.basename(f)).join(', ')} changed`);
      else this.afterLoad(`Re-indexed ${files.map((f) => path.basename(f)).join(', ')}`);
    }, DEBOUNCE_MS);
  }

  /** Log the load, refresh badges and notify listeners. Never reveals the output panel. */
  private afterLoad(what: string): void {
    const ws = this.ws!;
    const rel = (f: string) => path.relative(ws.opts.root, f);
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${what}: ${ws.projects.length} project(s), ${new Set(ws.files()).size} file(s)`);
    for (const p of ws.projects) this.output.appendLine(`  ${rel(p.file)}: ${[...p.packages.keys()].map(rel).join(', ') || '(no packages)'}`);
    this.output.appendLine(`  counts: ${Object.entries(ws.counts()).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    for (const d of ws.diagnostics) this.output.appendLine(`  ${d.severity}: ${rel(d.file)}:${d.line}: ${d.message}`);
    this.refreshMarks();
    this.reportProblems();
    this.changed.fire();
  }

  private refreshMarks(): void {
    const ws = this.ws!;
    this.diff.clear();
    this.marks.clear();
    const mark = (p: string | undefined, kind: 'problem' | 'generated') => {
      for (let n: XNode | undefined = p ? ws.get(p) : undefined; n; n = n.navParent) if (this.marks.get(n.path) !== 'problem') this.marks.set(n.path, kind);
    };
    if (this.config<boolean>('showGenerated') && this.config<string>('generatedDir')) {
      for (const e of diffGenerated(ws, this.config<string>('generatedDir')).entries) {
        if (e.path) this.diff.set(e.path, e);
        mark(e.path, 'generated');
      }
    }
    for (const d of ws.diagnostics) mark(d.path, 'problem');
  }

  /** One non-modal warning per distinct message; the output panel opens only when the user asks for it. */
  private reportProblems(): void {
    const fresh = this.ws!.diagnostics.map((d) => d.message).filter((m) => !this.reported.has(m));
    if (!fresh.length) return;
    fresh.forEach((m) => this.reported.add(m));
    const text = fresh.length === 1 ? `ECU-TEST: ${fresh[0]}` : `ECU-TEST: ${fresh.length} problems, e.g. ${fresh[0]}`;
    void vscode.window.showWarningMessage(text, 'Show output').then((choice) => choice && this.output.show(true));
  }

  /** Apply a plan as one undo-able WorkspaceEdit and save the touched documents so the model matches the disk. */
  async applyPlan(plan: EditPlan): Promise<boolean> {
    const edit = new vscode.WorkspaceEdit();
    for (const c of plan.creates) {
      const uri = vscode.Uri.file(c.file);
      edit.createFile(uri, { ignoreIfExists: true });
      edit.insert(uri, new vscode.Position(0, 0), c.content);
    }
    const docs: vscode.TextDocument[] = [];
    for (const [file, edits] of groupByFile(plan.edits)) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      if (doc.isDirty) {
        void vscode.window.showWarningMessage(`ECU-TEST: ${path.basename(file)} has unsaved changes. Save it first so edits hit the right offsets.`);
        return false;
      }
      docs.push(doc);
      for (const e of edits) edit.replace(doc.uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
      void vscode.window.showErrorMessage(`ECU-TEST: could not apply "${plan.summary}"`);
      return false;
    }
    for (const c of plan.creates) docs.push(await vscode.workspace.openTextDocument(vscode.Uri.file(c.file)));
    await Promise.all(docs.map((d) => d.save()));
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${plan.summary}`);
    // Do not wait for the watcher: callers re-render right away.
    if (this.timer) clearTimeout(this.timer);
    this.pending = new Set();
    if (this.ws && [...plan.creates.map((c) => c.file), ...plan.edits.map((e) => e.file)].every((f) => this.ws!.reloadFile(f) !== 'none')) this.afterLoad(plan.summary);
    else this.reload(plan.summary);
    return true;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }
}
