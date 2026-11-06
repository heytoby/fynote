export const folderSeparator = '␟';

export function folderLabel(path: string): string {
  return path.split(folderSeparator).join(' / ');
}

export function folderLeaf(path: string): string {
  return path.slice(path.lastIndexOf(folderSeparator) + 1);
}

export function inFolder(path: string, folder: string, descendants = false): boolean {
  return path === folder || (descendants && path.startsWith(folder + folderSeparator));
}

export function folderRows(paths: string[], expanded: ReadonlySet<string>) {
  const children = new Map<string, string[]>();
  const known = new Set(paths);
  for (const path of paths) {
    const parent = path.slice(0, Math.max(0, path.lastIndexOf(folderSeparator)));
    const key = known.has(parent) ? parent : '';
    const siblings = children.get(key) || [];
    siblings.push(path);
    children.set(key, siblings);
  }
  const rows: { path: string; name: string; depth: number; hasChildren: boolean }[] = [];
  const pending = (children.get('') || []).map(path => ({ path, depth: 0 })).reverse();
  while (pending.length) {
    const { path, depth } = pending.pop()!;
    const nested = children.get(path) || [];
    rows.push({ path, depth, name: folderLeaf(path), hasChildren: nested.length > 0 });
    if (expanded.has(path)) {
      for (let i = nested.length - 1; i >= 0; i--) pending.push({ path: nested[i], depth: depth + 1 });
    }
  }
  return rows;
}
