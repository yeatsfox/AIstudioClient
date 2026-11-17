// Path containment for the local tools.
//
// Every path the model supplies is resolved against the allowed roots and then
// re-checked after symlink resolution, so `..` traversal and links that point
// outside the workspace are both rejected. This module holds no I/O state.
import fs from 'node:fs/promises';
import path from 'node:path';

export class PathDeniedError extends Error {
  constructor(requested, roots) {
    super(
      `Path is outside the allowed workspace: ${requested}\nAllowed roots:\n${roots
        .map((r) => `  - ${r}`)
        .join('\n')}`,
    );
    this.name = 'PathDeniedError';
  }
}

/** Normalise a root once so later comparisons are stable on Windows and POSIX. */
export function normalizeRoots(roots) {
  return roots.map((root) => path.resolve(root));
}

/**
 * True when `candidate` is `root` itself or lives underneath it. A plain
 * startsWith() would accept "C:\\work2" for root "C:\\work", so the separator
 * is required.
 */
export function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve a model-supplied path to an absolute path inside the workspace.
 *
 * `mode` is 'existing' for reads (the target must already exist) and 'create'
 * for writes (the parent must exist and must itself be contained). Symlinks are
 * resolved on the deepest existing ancestor so a link cannot escape the roots.
 */
export async function resolveWithinRoots(requested, roots, mode = 'existing') {
  if (typeof requested !== 'string' || !requested.trim()) {
    throw new Error('A non-empty path is required.');
  }
  if (requested.includes('\0')) {
    throw new Error('Path contains a NUL byte.');
  }

  const absolute = path.resolve(requested);
  const directMatch = roots.find((root) => isInside(root, absolute));

  if (mode === 'existing') {
    if (!directMatch) throw new PathDeniedError(requested, roots);
    // A symlink inside the workspace may point outside it; compare the real path.
    const real = await fs.realpath(absolute).catch(() => {
      throw new Error(`Path does not exist: ${requested}`);
    });
    if (!roots.some((root) => isInside(root, real))) {
      throw new PathDeniedError(requested, roots);
    }
    return real;
  }

  // Writes: the file may not exist yet, so validate the parent and then guard
  // against an existing symlink at the target itself.
  const parent = path.dirname(absolute);
  if (!roots.some((root) => isInside(root, parent) || isInside(root, absolute))) {
    throw new PathDeniedError(requested, roots);
  }

  const realParent = await fs.realpath(parent).catch(() => {
    throw new Error(`Parent directory does not exist: ${parent}`);
  });
  if (!roots.some((root) => isInside(root, realParent))) {
    throw new PathDeniedError(requested, roots);
  }

  const target = path.join(realParent, path.basename(absolute));
  const existing = await fs.lstat(target).catch(() => null);
  if (existing?.isSymbolicLink()) {
    const realTarget = await fs.realpath(target).catch(() => null);
    if (!realTarget || !roots.some((root) => isInside(root, realTarget))) {
      throw new PathDeniedError(requested, roots);
    }
    return realTarget;
  }
  return target;
}
