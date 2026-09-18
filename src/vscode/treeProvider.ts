// The "Tests" tree: projects → folders/packages → parameters, mappings, steps. Badges come from a
// FileDecorationProvider keyed by an `ecutest:` URI that carries the element path.
import * as vscode from 'vscode';
import { XNode } from '../core/model';
import { allowedStepTypes, nameRefs } from '../core/schema';
import { ModelService } from './modelService';

const ICONS: Record<string, string> = { project: 'project', folder: 'folder', packageRef: 'package', package: 'library', parameter: 'symbol-variable', mapping: 'plug', step: 'debug-step-over', element: 'symbol-field', info: 'info', section: 'list-tree' };
const STEP_ICONS: Record<string, string> = { TsBlock: 'symbol-namespace', TsPrecondBlock: 'debug-start', TsPostcondBlock: 'debug-stop', TsComment: 'comment', TsWait: 'watch', TsLoop: 'sync', TsBreak: 'debug-disconnect', TsIfThenElse: 'git-compare', THEN: 'check', ELSE: 'close', TsCalculation: 'symbol-operator', tsRead: 'arrow-down', tsWrite: 'arrow-up', tsPackage: 'references' };

export const nodeUri = (node: XNode) => vscode.Uri.from({ scheme: 'ecutest', path: node.path });

/** Context value parts drive the context menu: value, named, steps, package, packages, removable. */
export function contextOf(node: XNode): string {
  const parts: string[] = [node.kind];
  if (node.valueRef || node.kind === 'parameter') parts.push('value');
  if (nameRefs(node).length) parts.push('named');
  if (allowedStepTypes(node).length) parts.push('steps');
  if (node.kind === 'project' || node.kind === 'folder') parts.push('packages');
  if (node.kind !== 'project' && node.kind !== 'package' && node.tag !== 'THEN' && node.tag !== 'ELSE') parts.push('removable');
  return parts.join(' ');
}

export class TestsTreeProvider implements vscode.TreeDataProvider<XNode>, vscode.FileDecorationProvider {
  private readonly treeChanged = new vscode.EventEmitter<void>();
  private readonly decorationsChanged = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.treeChanged.event;
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;

  constructor(private readonly model: ModelService) {
    model.onDidChange(() => {
      this.treeChanged.fire();
      this.decorationsChanged.fire(undefined);
    });
  }

  getChildren(node?: XNode): XNode[] {
    return node ? node.navChildren : this.model.ws?.roots() ?? [];
  }

  getParent(node: XNode): XNode | undefined {
    return node.navParent;
  }

  getTreeItem(node: XNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.name, node.navChildren.length ? (node.kind === 'project' || node.kind === 'folder' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
    const missing = node.kind === 'packageRef' && !node.pkg;
    item.id = node.path;
    item.resourceUri = nodeUri(node);
    item.description = missing ? `missing: ${node.ref?.raw}` : node.value !== undefined && node.value !== '' ? `= ${node.value.replace(/\s+/g, ' ')}` : node.kind === 'step' && node.name !== node.label ? node.label : undefined;
    item.tooltip = new vscode.MarkdownString(`\`${node.path}\`\n\n${node.label ?? node.kind} — ${vscode.workspace.asRelativePath(node.file)}:${node.line}`);
    item.iconPath = new vscode.ThemeIcon(missing ? 'warning' : (node.kind === 'step' && STEP_ICONS[node.label ?? '']) || ICONS[node.kind] || 'symbol-field');
    item.contextValue = contextOf(node);
    item.command = { command: this.model.config<boolean>('openInEditor') ? 'ecutest.open' : 'ecutest.revealInSource', title: 'Open', arguments: [node] };
    return item;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'ecutest') return undefined;
    const mark = this.model.marks.get(uri.path);
    if (!mark) return undefined;
    const own = mark === 'problem' ? this.model.ws?.diagnostics.some((d) => d.path === uri.path) : this.model.diff.has(uri.path);
    if (mark === 'problem') return { badge: own ? '!' : '·', tooltip: own ? 'Problem (see Description)' : 'Contains problems', color: new vscode.ThemeColor('list.warningForeground') };
    return { badge: own ? 'G' : '·', tooltip: own ? `Generated test.h differs: ${this.model.diff.get(uri.path)?.status}` : 'Contains elements that differ from the generated test.h', color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground') };
  }
}
