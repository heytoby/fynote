import { Injectable } from '@angular/core';
import { AuthService } from './auth.service';
import { NotesService } from './notes.service';
import { OfflineStoreService } from './offline-store.service';
import { OfflineSyncService } from './offline-sync.service';
import { WorkspaceService } from './workspace.service';
import { NoteI } from '../interfaces/notes';
import { folderSeparator } from '../utils/folder-path';
import { createUuid } from '../utils/uuid';

/** Bridge installed by the Electron preload script. */
type NotesBridge = {
  dir(): Promise<string>;
  list(): Promise<{ path: string; content: string; modifiedMs: number }[]>;
  write(relativePath: string, content: string): Promise<boolean>;
  remove(relativePath: string): Promise<boolean>;
};

function bridge(): NotesBridge | null {
  const api = (window as unknown as { fynote?: { notes?: NotesBridge } }).fynote;
  return api?.notes ?? null;
}

type FrontMatter = {
  id?: string;
  title?: string;
  pinned?: boolean;
  labels?: string;
  binder?: string;
  created?: string;
  updated?: string;
};

function parseMarkdown(raw: string): { meta: FrontMatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { meta: {}, body: raw };
  const meta: FrontMatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    const value = pair[2].replace(/^['"]|['"]$/g, '').trim();
    switch (pair[1]) {
      case 'id': meta.id = value; break;
      case 'title': meta.title = value; break;
      case 'pinned': meta.pinned = value === 'true'; break;
      case 'labels': meta.labels = value; break;
      case 'binder': meta.binder = value; break;
      case 'created': meta.created = value; break;
      case 'updated': meta.updated = value; break;
    }
  }
  return { meta, body: raw.slice(match[0].length) };
}

function yamlValue(value: string): string {
  return /^[A-Za-z0-9 _.,\-/]*$/.test(value) ? value : JSON.stringify(value);
}

function safeName(value: string): string {
  const cleaned = String(value || '')
    .replace(/[<>:"\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 80)
    .trim();
  return cleaned || 'Untitled';
}

@Injectable({ providedIn: 'root' })
export class MarkdownLibraryService {
  private started = false;
  private readonly lastContent = new Map<string, string>();
  private readonly lastPath = new Map<string, string>();

  constructor(
    private auth: AuthService,
    private workspace: WorkspaceService,
    private store: OfflineStoreService,
    private sync: OfflineSyncService,
    private notes: NotesService
  ) {}

  async start(): Promise<void> {
    const api = bridge();
    if (this.started || !api) return;
    this.started = true;
    try {
      await this.workspace.ready;
      if (!this.auth.isLocal) return;
      await this.importFromDisk();
      await this.notes.load().catch(() => undefined);
      this.sync.cacheChanged$.subscribe(() => { void this.exportToDisk(); });
      await this.exportToDisk();
    } catch (error) {
      console.error('Markdown library unavailable', error);
    }
  }

  private async importFromDisk(): Promise<void> {
    const api = bridge();
    const workspace = this.workspace.local;
    if (!api || !workspace) return;
    const files = await api.list();
    if (!files.length) return;
    const partition = this.sync.partition;
    if (!partition) return;
    const stored = await this.store.listNotes(partition);
    const byId = new Map(stored.map((note) => [String(note.syncId || ''), note]));
    for (const file of files) {
      const { meta, body } = parseMarkdown(file.content);
      const existing = meta.id ? byId.get(meta.id) : undefined;
      const modified = new Date(file.modifiedMs).toISOString();
      const source = body.replace(/\r\n/g, '\n');
      if (!existing) {
        const syncId = meta.id || `note-${createUuid()}`;
        if (byId.has(syncId)) continue;
        await this.store.commitMutation(workspace, 'note.upsert', syncId, {
          syncId,
          noteTitle: meta.title || this.titleFromPath(file.path),
          markdownSource: source,
          contentFormat: 'markdown',
          noteBody: '',
          pinned: meta.pinned === true,
          bgColor: '#ffffff',
          bgImage: '',
          isCbox: false,
          labels: [],
          binder: this.binderFromPath(file.path),
          createdAt: meta.created || modified,
          updatedAt: meta.updated || modified
        } as unknown as Record<string, unknown>);
        continue;
      }
      const storedBody = String(existing.markdownSource || '').replace(/\r\n/g, '\n');
      const fileNewer = new Date(file.modifiedMs).getTime() > Date.parse(String(existing.updatedAt || '')) + 1000;
      if (fileNewer && source !== storedBody) {
        await this.store.commitMutation(workspace, 'note.upsert', String(existing.syncId), {
          ...existing,
          markdownSource: source,
          contentFormat: 'markdown',
          noteTitle: meta.title || existing.noteTitle
        } as unknown as Record<string, unknown>);
      }
    }
  }

  private async exportToDisk(): Promise<void> {
    const api = bridge();
    const workspace = this.workspace.local;
    if (!api || !workspace || !this.auth.isLocal) return;
    const partition = this.sync.partition;
    if (!partition) return;
    const notes = await this.store.listNotes(partition);
    for (const note of notes) {
      if (!note.syncId) continue;
      const relativePath = this.notePath(note);
      const content = this.serialize(note);
      const previousPath = this.lastPath.get(note.syncId);
      if (previousPath && previousPath !== relativePath) {
        await api.remove(previousPath).catch(() => false);
      }
      if (this.lastContent.get(note.syncId) !== content) {
        await api.write(relativePath, content);
        this.lastContent.set(note.syncId, content);
      }
      this.lastPath.set(note.syncId, relativePath);
    }
  }

  private notePath(note: NoteI): string {
    const folder = String(note.binder || '')
      .split(folderSeparator)
      .filter((part) => part.trim())
      .map((part) => safeName(part))
      .join('/');
    const base = safeName(note.noteTitle || 'Untitled');
    return folder ? `${folder}/${base}.md` : `${base}.md`;
  }

  private serialize(note: NoteI): string {
    const labels = (note.labels || []).map((label) => label.name).filter(Boolean).join(', ');
    const binder = String(note.binder || '').split(folderSeparator).join('/');
    const lines = [
      '---',
      `id: ${note.syncId}`,
      `title: ${yamlValue(String(note.noteTitle || ''))}`,
      `created: ${note.createdAt || ''}`,
      `updated: ${note.updatedAt || ''}`,
      `pinned: ${note.pinned === true}`,
      `labels: ${yamlValue(labels)}`,
      `binder: ${yamlValue(binder)}`,
      '---',
      '',
      String(note.markdownSource || note.noteBody || '')
    ];
    return lines.join('\n');
  }

  private titleFromPath(relativePath: string): string {
    const name = relativePath.split('/').pop() || 'Untitled';
    return name.replace(/\.md$/i, '');
  }

  private binderFromPath(relativePath: string): string {
    const parts = relativePath.split('/');
    parts.pop();
    return parts.join(folderSeparator);
  }
}
