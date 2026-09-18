// Project discovery: find .prj files under a root and resolve the package files they reference.
import * as fs from 'fs';
import * as path from 'path';

export interface DiscoveryOptions {
  root: string;
  projectGlob?: string;
  ignoreGlobs?: string[];
  /** Extra folders (absolute or relative to root) searched when resolving package references. */
  packageBaseDirs?: string[];
  /** Restrict to one project: a name (without extension) or a path relative to root. */
  project?: string;
}

export const DEFAULT_PROJECT_GLOB = '**/*.prj';
export const DEFAULT_IGNORES = ['**/node_modules/**', '**/.git/**', '**/build/**', '**/out/**', '**/dist/**', '**/gen/**', '**/TestReports/**'];

/** Convert a glob (**, *, ?, {a,b}) to a RegExp over forward-slash relative paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function findProjects(opts: DiscoveryOptions): string[] {
  const match = globToRegExp(opts.projectGlob || DEFAULT_PROJECT_GLOB);
  const ignores = (opts.ignoreGlobs ?? DEFAULT_IGNORES).map(globToRegExp);
  const found: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      const rel = toPosix(path.relative(opts.root, full));
      if (e.isDirectory()) {
        if (!ignores.some((r) => r.test(rel + '/') || r.test(rel + '/x'))) visit(full);
      } else if (match.test(rel) && !ignores.some((r) => r.test(rel))) found.push(full);
    }
  };
  visit(opts.root);
  if (!opts.project) return found;
  const want = toPosix(opts.project).replace(/\.prj$/i, '').toLowerCase();
  return found.filter((f) => {
    const rel = toPosix(path.relative(opts.root, f)).replace(/\.prj$/i, '').toLowerCase();
    return rel === want || path.basename(rel) === want;
  });
}

/** Folders tried, in order, for a package reference found in `prjFile`. */
export function searchDirs(prjFile: string, opts: DiscoveryOptions): string[] {
  const dirs = [path.dirname(prjFile), opts.root];
  for (const b of opts.packageBaseDirs ?? []) dirs.push(path.resolve(opts.root, b));
  // ECU-TEST workspaces keep packages in a "Packages" folder next to (or above) the project folder.
  for (let d = path.dirname(prjFile); ; d = path.dirname(d)) {
    dirs.push(path.join(d, 'Packages'));
    if (path.relative(opts.root, d) === '' || path.dirname(d) === d || path.relative(opts.root, d).startsWith('..')) break;
  }
  return [...new Set(dirs)];
}

/**
 * Resolve a raw reference (may use backslashes or be an absolute path from another machine).
 * Tries the full relative path in every search dir, then progressively shorter suffixes of absolute paths.
 */
export function resolvePackage(raw: string, prjFile: string, opts: DiscoveryOptions): string | undefined {
  const ref = toPosix(raw.trim());
  if (!ref) return undefined;
  if (path.isAbsolute(ref) && fs.existsSync(ref)) return path.normalize(ref);
  const absolute = /^([a-zA-Z]:)?\//.test(ref);
  const segments = ref.replace(/^([a-zA-Z]:)?\/+/, '').split('/').filter((s) => s && s !== '.');
  const dirs = searchDirs(prjFile, opts);
  const limit = absolute ? segments.length : 1;
  for (let skip = 0; skip < limit; skip++) {
    const rel = segments.slice(skip).join('/');
    for (const d of dirs) {
      const candidate = path.resolve(d, rel);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return undefined;
}
