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
  // ECU-TEST resolves references against the workspace "Packages" folder. It may sit next to the project folder,
  // above it, or even above the opened root (when only a sub folder of the ECU-TEST workspace is opened).
  for (let d = path.dirname(prjFile); ; d = path.dirname(d)) {
    // The folder itself also covers references written relative to the workspace ("Packages\\X.pkg").
    dirs.push(d, path.join(d, 'Packages'));
    if (path.dirname(d) === d) break;
  }
  return [...new Set(dirs)];
}

/** All .pkg files below the root and below the enclosing ECU-TEST "Packages" folder, listed once per load. */
export class PackageLocator {
  private files?: string[];
  constructor(private readonly opts: DiscoveryOptions) {}

  private list(prjFile: string): string[] {
    if (this.files) return this.files;
    const ignores = (this.opts.ignoreGlobs ?? DEFAULT_IGNORES).map(globToRegExp);
    const found = new Set<string>();
    const visit = (top: string, dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        const rel = toPosix(path.relative(top, full));
        if (e.isDirectory()) {
          if (!ignores.some((r) => r.test(rel + '/'))) visit(top, full);
        } else if (/\.pkg$/i.test(e.name)) found.add(full);
      }
    };
    const tops = [this.opts.root, ...(this.opts.packageBaseDirs ?? []).map((b) => path.resolve(this.opts.root, b))];
    for (let d = path.dirname(prjFile); path.dirname(d) !== d; d = path.dirname(d)) if (path.basename(d).toLowerCase() === 'packages') tops.push(d);
    for (const top of new Set(tops)) visit(top, top);
    return (this.files = [...found]);
  }

  /**
   * Fallback when the reference does not exist as written: the file whose path ends with the most trailing
   * segments of the reference (case-insensitive, at least the file name); ties go to the file closest to the project.
   */
  find(segments: string[], prjFile: string): string | undefined {
    const want = segments.filter((s) => s !== '..').map((s) => s.toLowerCase()).reverse();
    let best: { file: string; score: number; distance: number } | undefined;
    for (const file of this.list(prjFile)) {
      const have = toPosix(file).toLowerCase().split('/').reverse();
      let score = 0;
      while (score < want.length && have[score] === want[score]) score++;
      if (!score) continue;
      const distance = toPosix(path.relative(path.dirname(prjFile), file)).split('/').length;
      if (!best || score > best.score || (score === best.score && distance < best.distance)) best = { file, score, distance };
    }
    return best?.file;
  }
}

/**
 * Resolve a raw reference (may use backslashes or be an absolute path from another machine).
 * Tries the full relative path in every search dir, then progressively shorter suffixes of absolute paths,
 * and finally looks the file up by its trailing path among all packages (`locator`).
 */
export function resolvePackage(raw: string, prjFile: string, opts: DiscoveryOptions, locator?: PackageLocator): string | undefined {
  const trimmed = toPosix(raw.trim());
  if (!trimmed) return undefined;
  // Some references omit the extension.
  const ref = /\.pkg$/i.test(trimmed) ? trimmed : trimmed + '.pkg';
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
  return locator?.find(segments, prjFile);
}
