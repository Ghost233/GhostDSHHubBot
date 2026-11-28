/**
 * Path guards (双轴审查 P2: extracted from tasks.js — a path utility is not lifecycle domain).
 */

import { isAbsolute, relative, sep } from 'node:path'

/** Compare absolute workspace paths after resolving their path segments. */
export function isWithinCwd(root, candidate) {
  if (typeof root !== 'string' || typeof candidate !== 'string' || !isAbsolute(root) || !isAbsolute(candidate)) return false
  const fromRoot = relative(root, candidate)
  return fromRoot !== '..' && !fromRoot.startsWith('..' + sep) && !isAbsolute(fromRoot)
}
