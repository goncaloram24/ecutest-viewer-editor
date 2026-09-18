// One command table shared by the CLI and the MCP server, so both always expose identical capabilities.
import { describe, renderDescription } from './describe';
import { diffGenerated } from './diff';
import { EditPlan } from './edit';
import { generateModel, renderHeader } from './generate';
import { diffView, infoView, nodeView, planView, searchView, treeLines } from './json';
import { addPackage, addParam, addStep, deleteNode, moveNode, newProject, rename, setValue } from './ops';
import { schemaFor } from './schema';
import { Workspace } from './workspace';

export const PATH_DOC =
  'Paths address elements (never file names): /<project> is a .prj, /<project>/<package path relative to the project, forward slashes, no .pkg> is a package, ' +
  'deeper segments are step/parameter/mapping names as printed by tree (duplicates get #2, #3, ...). A field or attribute of an element is <path>/@NAME.';

export interface Param {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  doc: string;
  /** Position on the CLI command line; options without a position are passed as --name. */
  positional?: boolean;
}

export interface Command {
  name: string;
  tool: string;
  write: boolean;
  description: string;
  params: Param[];
  run(ws: Workspace, a: Record<string, any>, ctx: { generatedDir?: string }): unknown;
}

const P = (name: string, doc: string, extra: Partial<Param> = {}): Param => ({ name, type: 'string', required: true, positional: true, doc, ...extra });
const OPT = (name: string, doc: string, type: Param['type'] = 'string'): Param => ({ name, type, doc });
const DRY = OPT('dryRun', 'Return the text edits without writing anything', 'boolean');
const pathParam = (doc = 'Element path') => P('path', `${doc}. ${PATH_DOC}`);

function write(ws: Workspace, a: Record<string, any>, plan: EditPlan) {
  if (!a.dryRun) ws.apply(plan);
  return planView(ws, plan, !a.dryRun);
}

export const COMMANDS: Command[] = [
  { name: 'info', tool: 'ecutest_info', write: false, description: 'START HERE. Lists the loaded projects, their packages (with paths), element counts and diagnostics such as missing packages.', params: [], run: (ws) => infoView(ws) },
  {
    name: 'tree', tool: 'ecutest_tree', write: false,
    description: 'Navigate: prints the element tree below a path, one line per element ("segment [type] = value"). Append a segment to the parent path to address a child.',
    params: [P('path', `Where to start (default: all projects). ${PATH_DOC}`, { required: false }), OPT('depth', 'Levels to print (default 2)', 'number')],
    run: (ws, a) => (a.path ? [ws.resolve(a.path)] : ws.roots()).flatMap((n) => treeLines(n, a.depth ?? 2)).join('\n'),
  },
  {
    name: 'get', tool: 'ecutest_get', write: false,
    description: 'Read one element as compact JSON: kind, type, name, value, fields, attributes, children and source file:line.',
    params: [pathParam(), OPT('depth', 'Levels of children to include (default 1)', 'number')],
    run: (ws, a) => nodeView(ws, ws.resolve(a.path), a.depth ?? 1),
  },
  {
    name: 'search', tool: 'ecutest_search', write: false,
    description: 'Find elements by text (name, value, step type, field content or exact step id). Returns paths to use with the other tools.',
    params: [P('text', 'Text to look for (case-insensitive)'), OPT('limit', 'Maximum results (default 50)', 'number')],
    run: (ws, a) => searchView(ws, ws.search(a.text, a.limit ?? 50)),
  },
  {
    name: 'schema', tool: 'ecutest_schema', write: false,
    description: 'What is allowed at a path: step types that can be added, editable value/fields/attributes with their types and allowed values, and the operations that apply. Check this before adding or setting.',
    params: [pathParam()],
    run: (ws, a) => schemaFor(ws.resolve(a.path)),
  },
  {
    name: 'describe', tool: 'ecutest_describe', write: false,
    description: 'Plain-language explanation of an element: what it does in ECU-TEST, allowed values, which test.h function it becomes and where it is referenced.',
    params: [pathParam()],
    run: (ws, a) => renderDescription(describe(ws, ws.resolve(a.path))),
  },
  {
    name: 'generate-preview', tool: 'ecutest_generate_preview', write: false,
    description: 'Preview the C functions (void TC_<package>_<case>(void), with step skeleton) that the test.h generator emits for a project, package or block.',
    params: [P('path', `Project, package or block (default: everything). ${PATH_DOC}`, { required: false })],
    run: (ws, a) => {
      const cases = generateModel(ws, a.path ? ws.resolve(a.path) : undefined);
      return cases.length ? cases.map((c) => c.text).join('\n\n') : 'No test.h functions are generated from this element.';
    },
  },
  {
    name: 'diff', tool: 'ecutest_diff', write: false,
    description: 'Compare the current model with an existing generated test.h folder: functions that are missing, changed or no longer produced, with the path of the responsible element.',
    params: [P('generatedDir', 'Generated output folder, relative to the root (default: the --generated-dir of the server/CLI)', { required: false })],
    run: (ws, a, ctx) => {
      const dir = a.generatedDir ?? ctx.generatedDir;
      if (!dir) throw new Error('No generated folder given: pass generatedDir or start with --generated-dir <dir>');
      return diffView(ws, diffGenerated(ws, dir));
    },
  },
  {
    name: 'set', tool: 'ecutest_set_value', write: true,
    description: 'Set the value of an element (parameter default, wait time, comment text, loop count, written value, ...) or of one field/attribute via <path>/@NAME. Validated against the schema.',
    params: [pathParam('Element, or <element>/@FIELD'), P('value', 'New value (booleans are True/False)'), DRY],
    run: (ws, a) => write(ws, a, setValue(ws, a.path, String(a.value))),
  },
  {
    name: 'add-step', tool: 'ecutest_add_step', write: true,
    description: 'Add a test step to a package or container step (block, loop, Then/Else, case). Call schema on the parent first to see allowed types and what name/value mean for each type.',
    params: [P('parent', `Package or container step. ${PATH_DOC}`), P('type', 'Step type, e.g. TsBlock, TsWait, TsComment, TsLoop, TsIfThenElse, TsCalculation, tsRead, tsWrite, tsPackage, TsBreak'), OPT('name', 'Block title / mapping name / result variable, depending on the type'), OPT('value', 'Main value: seconds, comment text, loop count, condition, formula, value to write, package path'), OPT('after', 'Path of the sibling step to insert after (default: at the end)'), OPT('before', 'Path of the sibling step to insert before'), DRY],
    run: (ws, a) => write(ws, a, addStep(ws, a.parent, a.type, { name: a.name, value: a.value === undefined ? undefined : String(a.value), after: a.after, before: a.before })),
  },
  {
    name: 'add-param', tool: 'ecutest_add_param', write: true,
    description: 'Add a variable to a package: a parameter (in), a return value (out) or a local variable, with a default value whose type is inferred.',
    params: [P('package', `Package path. ${PATH_DOC}`), P('name', 'Variable name (identifier)'), P('value', 'Default value'), OPT('direction', 'in (default), out or local'), DRY],
    run: (ws, a) => {
      if (a.direction && !['in', 'out', 'local'].includes(a.direction)) throw new Error('direction must be in, out or local');
      return write(ws, a, addParam(ws, a.package, a.name, String(a.value), a.direction ?? 'in'));
    },
  },
  {
    name: 'add-package', tool: 'ecutest_add_package', write: true,
    description: 'Reference a package from a project (or project folder). Creates a minimal valid .pkg if the file does not exist yet. This is the only place a file name is used: it is relative to the project folder.',
    params: [P('project', `Project or folder path. ${PATH_DOC}`), P('file', 'Package file relative to the project folder, e.g. Body/NewTest.pkg'), OPT('name', 'Test case name shown in the project (default: file name)'), DRY],
    run: (ws, a) => write(ws, a, addPackage(ws, a.project, a.file, a.name)),
  },
  {
    name: 'rename', tool: 'ecutest_rename', write: true,
    description: 'Rename a block, parameter/variable, mapping, folder or package test case. Renaming a variable or mapping also updates the references inside its package.',
    params: [pathParam(), P('name', 'New name'), DRY],
    run: (ws, a) => write(ws, a, rename(ws, a.path, a.name)),
  },
  {
    name: 'delete', tool: 'ecutest_delete', write: true,
    description: 'Delete an element (step with its children, parameter, mapping, folder, or a package reference; .pkg files are never deleted).',
    params: [pathParam(), DRY],
    run: (ws, a) => write(ws, a, deleteNode(ws, a.path)),
  },
  {
    name: 'move', tool: 'ecutest_move', write: true,
    description: 'Reorder or re-parent an element: place it after (or before) another element of the same kind in the same file, e.g. a step after another step.',
    params: [pathParam('Element to move'), OPT('after', 'Path of the element it should follow'), OPT('before', 'Path of the element it should precede'), DRY],
    run: (ws, a) => write(ws, a, moveNode(ws, a.path, { after: a.after, before: a.before })),
  },
  {
    name: 'new-project', tool: 'ecutest_new_project', write: true,
    description: 'Create a new empty project file. The file name is relative to the root; afterwards it is addressed as /<file name without .prj>.',
    params: [P('file', 'Project file relative to the root, e.g. Smoke.prj'), DRY],
    run: (ws, a) => write(ws, a, newProject(ws, a.file)),
  },
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name || c.tool === name);
}

export const renderHeaderFor = (ws: Workspace) => renderHeader(generateModel(ws), ws.projects.map((p) => p.name).join(', '));
