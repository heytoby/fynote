#!/usr/bin/env node
/**
 * Export a Fynote SQLite library into the Markdown layout used by the local
 * desktop app: one .md per note, folders as directories, metadata in YAML
 * front matter.
 *
 * Usage:
 *   node scripts/export-workspace-to-markdown.cjs [--db <kept.sqlite>] [--out <dir>]
 *
 * Defaults: %LOCALAPPDATA%\Kept\data\kept.sqlite and %USERPROFILE%\Documents\Fynote
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sqlite3 = require('sqlite3');

const args = process.argv.slice(2);
const argOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const databasePath = argOf('--db') ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Kept', 'data', 'kept.sqlite');
const outputDir = argOf('--out') || path.join(os.homedir(), 'Documents', 'Fynote');

if (!fs.existsSync(databasePath)) {
  console.error('Database not found: ' + databasePath);
  process.exit(1);
}

const separator = '\u241f';
const db = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);
const all = (sql, params = []) => new Promise((resolve, reject) =>
  db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows))));

function safeName(value) {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 80)
    .trim();
  return cleaned || 'Untitled';
}

function yamlValue(value) {
  return /^[A-Za-z0-9 _.,\-/]*$/.test(value) ? value : JSON.stringify(value);
}

(async () => {
  const notes = await all(`SELECT * FROM notes WHERE trashed = 0 OR trashed IS NULL ORDER BY id`);
  const labels = await all('SELECT id, name FROM labels');
  const labelById = new Map(labels.map((label) => [label.id, label.name]));

  let written = 0;
  const used = new Set();
  for (const note of notes) {
    const rawTitle = String(note.noteTitle || '').trim();
    const plainBody = String(note.markdownSource || note.noteBody || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const title = (rawTitle || plainBody).slice(0, 80).trim() || `Untitled ${note.id}`;
    const folderParts = String(note.binder || '').split(separator).filter((part) => part.trim()).map(safeName);
    const body = String(note.markdownSource || note.noteBody || '');
    const labelNames = Array.isArray(note.labels)
      ? note.labels.map((item) => (typeof item === 'string' ? item : item && item.name)).filter(Boolean)
      : [];
    const id = note.syncId || `note-${note.id}`;
    let relative = path.join(...folderParts, `${safeName(title)}.md`);
    let counter = 2;
    while (used.has(relative.toLowerCase())) relative = path.join(...folderParts, `${safeName(title)} (${counter++}).md`);
    used.add(relative.toLowerCase());

    const front = [
      '---',
      `id: ${id}`,
      `title: ${yamlValue(title)}`,
      `created: ${note.createdAt || ''}`,
      `updated: ${note.updatedAt || ''}`,
      `pinned: ${note.pinned === 1 || note.pinned === true}`,
      `labels: ${yamlValue(labelNames.join(', '))}`,
      `binder: ${yamlValue(folderParts.join('/'))}`,
      '---',
      '',
      body
    ].join('\n');

    const target = path.join(outputDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, front, 'utf8');
    written++;
  }

  console.log(JSON.stringify({ database: databasePath, output: outputDir, notes: notes.length, written }, null, 2));
  db.close();
})().catch((error) => {
  console.error('Export failed: ' + error.message);
  process.exit(1);
});
