import assert from 'node:assert/strict';
import { test } from 'node:test';
import { folderRows, folderSeparator, inFolder } from '../src/app/utils/folder-path.ts';

test('folder hierarchy has no fixed depth and preserves siblings with matching names', () => {
  const nested = Array.from({ length: 512 }, (_, i) =>
    Array.from({ length: i + 1 }, (_, j) => 'folder-' + j).join(folderSeparator));
  const duplicateLeaf = ['other', 'folder-1'].join(folderSeparator);
  const paths = [...nested, 'other', duplicateLeaf];
  assert.equal(folderRows(paths, new Set()).length, 2);
  const rows = folderRows(paths, new Set(paths));
  assert.equal(rows.length, paths.length);
  assert.equal(rows.find(row => row.path === nested.at(-1)).depth, 511);
  assert.deepEqual(rows.filter(row => row.name === 'folder-1').map(row => row.path), [nested[1], duplicateLeaf]);
});

test('folder filtering keeps the exact folder or its descendants without matching siblings', () => {
  const parent = 'Work';
  const notes = [parent, parent + folderSeparator + 'Invoices', 'Workplace', ''];
  assert.deepEqual(notes.filter(path => inFolder(path, parent)), [notes[0]]);
  assert.deepEqual(notes.filter(path => inFolder(path, parent, true)), notes.slice(0, 2));
});
