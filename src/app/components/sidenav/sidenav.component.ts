import { folderLabel, folderLeaf, folderRows, folderSeparator, inFolder } from '../../utils/folder-path';
import { Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Subscription } from 'rxjs';
import { SharedService } from 'src/app/services/shared.service';
import { LabelActionsT } from 'src/app/interfaces/labels';
import { Router } from '@angular/router';
import { AuthService } from 'src/app/services/auth.service';

@Component({
    selector: 'app-sidenav',
    templateUrl: './sidenav.component.html',
    styleUrls: ['./sidenav.component.scss'],
    standalone: false
})
export class NavComponent implements OnInit, OnDestroy {
  @ViewChild("modalContainer") modalContainer !: ElementRef<HTMLInputElement>
  @ViewChild("modal") modal !: ElementRef<HTMLInputElement>
  @ViewChild("labelInput") labelInput !: ElementRef<HTMLInputElement>
  @ViewChild("labelError") labelError !: ElementRef<HTMLInputElement>
  @ViewChild("binderModalContainer") binderModalContainer !: ElementRef<HTMLInputElement>
  @ViewChild("binderModal") binderModal !: ElementRef<HTMLInputElement>
  @ViewChild("binderInput") binderInput !: ElementRef<HTMLInputElement>
  @ViewChild("binderError") binderError !: ElementRef<HTMLInputElement>

  installHelpOpen = false;

  bindersExpanded = false;
  labelsExpanded = false;
  binderBusy = false;
  binderParent = '';
  readonly expandedFolders = new Set<string>();
  readonly folderLabel = folderLabel;
  readonly folderLeaf = folderLeaf;

  get folders() {
    return folderRows(this.Shared.binder.list.map(folder => folder.name), this.expandedFolders);
  }

  toggleFolder(path: string) {
    if (this.expandedFolders.has(path)) this.expandedFolders.delete(path);
    else this.expandedFolders.add(path);
    this.saveExpandedFolders();
  }
  binderEditError = '';
  binderCreateError = '同一位置已有同名文件夹';
  labelBusy = false;
  labelEditError = '';
  private subscriptions: Subscription[] = [];

  constructor(public Shared: SharedService, public router: Router, public auth: AuthService) {
    this.Shared.initPwa();
  }

  // ? modal ----------------------------------------------------------
  openModal() {
    this.labelEditError = '';
    this.modalContainer.nativeElement.style.display = 'block';
    document.addEventListener('mousedown', this.mouseDownEvent)
  }
  hideModal() {
    this.modalContainer.nativeElement.style.display = 'none'
    document.removeEventListener('mousedown', this.mouseDownEvent)
  }
  mouseDownEvent = (event: Event) => {
    let modalEl = this.modal.nativeElement
    if (!(modalEl as any).contains(event.target)) {
      this.hideModal()
    }
  }

  // ? labels ----------------------------------------------------

  addLabel(el: HTMLInputElement) {
    if (!el || this.labelBusy) return
    this.Shared.label.db.add({ name: el.value })
      .then(() => { this.labelError.nativeElement.hidden = true; el.value = ''; el.focus() })
      .catch(x => { if (x.status === 409) this.labelError.nativeElement.hidden = false; el.focus() })
  }

  editLabel(id: number) {
    let actions: LabelActionsT = {
      delete: () => this.changeLabel(async () => {
        this.Shared.label.id = id
        await this.Shared.label.db.delete()
        await this.Shared.label.db.updateAllLabels('')
        this.labelError.nativeElement.hidden = true
      }),
      update: async (value: string) => {
        if (value.trim() === this.Shared.label.list.find(label => label.id === id)?.name) return;
        await this.changeLabel(async () => {
          this.Shared.label.id = id
          await this.Shared.label.db.update({ name: value })
          await this.Shared.label.db.updateAllLabels(value)
          this.labelError.nativeElement.hidden = true
        });
      }
    }
    return actions
  }

  async moveLabel(id: number, direction: -1 | 1, event: Event) {
    if (this.labelBusy) return;
    const button = event.currentTarget as HTMLButtonElement;
    const labels = [...this.Shared.label.list];
    const index = labels.findIndex(label => label.id === id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= labels.length) return;
    [labels[index], labels[next]] = [labels[next], labels[index]];
    await this.changeLabel(() => this.Shared.label.db.reorder(labels));
    setTimeout(() => {
      if (!button.isConnected) return;
      const target = button.disabled ? button.closest('.label-edit-row')?.querySelector<HTMLButtonElement>('button:not(:disabled)') : button;
      target?.focus();
    }, 0);
  }

  reorderLabels(names: string[]) {
    const labels = names.map(name => this.Shared.label.list.find(label => label.name === name));
    if (labels.some(label => !label)) return;
    return this.changeLabel(() => this.Shared.label.db.reorder(labels as typeof this.Shared.label.list));
  }

  reorderBinders(names: string[]) {
    return this.changeBinder(() => this.Shared.binder.db.reorder(names));
  }

  private async changeLabel(change: () => Promise<unknown>) {
    if (this.labelBusy) return;
    this.labelBusy = true;
    this.labelEditError = '';
    try {
      await change();
    } catch {
      this.labelEditError = 'Could not save your label changes. Please try again.';
    } finally {
      this.labelBusy = false;
    }
  }

  openBinderModal(focusNewBinder = false, parent = '') {
    this.binderParent = parent;
    this.binderEditError = '';
    if (this.binderError?.nativeElement) this.binderError.nativeElement.hidden = true;
    const container = this.binderModalContainer?.nativeElement;
    if (!container) return;
    container.style.display = 'block';
    document.addEventListener('mousedown', this.binderMouseDownEvent)
    if (focusNewBinder) setTimeout(() => this.binderInput?.nativeElement?.focus(), 0);
  }

  hideBinderModal() {
    this.binderModalContainer.nativeElement.style.display = 'none'
    document.removeEventListener('mousedown', this.binderMouseDownEvent)
  }

  binderMouseDownEvent = (event: Event) => {
    let modalEl = this.binderModal.nativeElement
    if (!(modalEl as any).contains(event.target)) {
      this.hideBinderModal()
    }
  }

  async addBinder(el: HTMLInputElement) {
    if (!el) return
    const name = el.value.trim()
    if (!name || this.binderBusy) return
    if (name.includes(folderSeparator)) return;
    const path = this.binderParent ? this.binderParent + folderSeparator + name : name;
    const exists = this.Shared.binder.list.some(binder => binder.name.toLowerCase() === path.toLowerCase())
    if (exists) {
      this.binderCreateError = '同一位置已有同名文件夹';
      this.binderError.nativeElement.hidden = false
      el.focus()
      return
    }
    this.binderBusy = true;
    this.binderError.nativeElement.hidden = true;
    try {
      await this.Shared.binder.db.add(path);
      if (this.binderParent) {
        this.expandedFolders.add(this.binderParent);
        this.saveExpandedFolders();
      }
      el.value = '';
      this.bindersExpanded = true;
    } catch {
      this.binderCreateError = '无法创建文件夹，请重试。';
      this.binderError.nativeElement.hidden = false;
    } finally {
      this.binderBusy = false;
      setTimeout(() => el.focus(), 0);
    }
  }

  editBinder(name: string) {
    return {
      delete: () => this.changeBinder(async () => {
        if (this.Shared.binder.list.some(folder => folder.name !== name && inFolder(folder.name, name, true))) {
          throw new Error('请先移出或删除子文件夹。');
        }
        await this.Shared.binder.db.delete(name);
      }),
      update: (value: string) => {
        const leaf = value.trim();
        if (!leaf || leaf === folderLeaf(name) || leaf.includes(folderSeparator)) return Promise.resolve();
        return this.changeBinder(async () => {
          const replacement = name.slice(0, name.length - folderLeaf(name).length) + leaf;
          const names = this.Shared.binder.list.map(folder => folder.name);
          const subtree = names.filter(path => inFolder(path, name, true));
          if (subtree.some(path => names.some(other => !subtree.includes(other) &&
            other.toLowerCase() === (replacement + path.slice(name.length)).toLowerCase()))) {
            throw new Error('同一位置已有同名文件夹。');
          }
          for (const path of subtree) await this.Shared.binder.db.update(path, replacement + path.slice(name.length));
        });
      }
    }
  }

  async moveBinder(name: string, direction: -1 | 1, event: Event) {
    if (this.binderBusy) return;
    const button = event.currentTarget as HTMLButtonElement;
    const names = this.Shared.binder.list.map(binder => binder.name);
    const index = names.indexOf(name);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= names.length) return;
    [names[index], names[next]] = [names[next], names[index]];
    await this.changeBinder(() => this.Shared.binder.db.reorder(names));
    // Disabling controls during the write drops keyboard focus in some browsers.
    setTimeout(() => {
      if (!button.isConnected) return;
      const target = button.disabled ? button.closest('.binder-edit-row')?.querySelector<HTMLButtonElement>('button:not(:disabled)') : button;
      target?.focus();
    }, 0);
  }

  private async changeBinder(change: () => Promise<unknown>) {
    if (this.binderBusy) return;
    this.binderBusy = true;
    this.binderEditError = '';
    try {
      await change();
    } catch (error) {
      this.binderEditError = error instanceof Error ? error.message : '文件夹更改保存失败。';
    } finally {
      this.binderBusy = false;
    }
  }

  toggleBinders() {
    this.bindersExpanded = !this.bindersExpanded;
    if (this.bindersExpanded) { this.labelsExpanded = false; this.saveSectionExpanded('labels', false); }
    this.saveSectionExpanded('binders', this.bindersExpanded);
  }

  toggleLabels() {
    this.labelsExpanded = !this.labelsExpanded;
    if (this.labelsExpanded) { this.bindersExpanded = false; this.saveSectionExpanded('binders', false); }
    this.saveSectionExpanded('labels', this.labelsExpanded);
  }

  compactLabel(name: string) {
    const words = String(name || '')
      .trim()
      .replace(/[^a-z0-9\s]/gi, ' ')
      .split(/\s+/)
      .filter(Boolean);
    if (!words.length) return '#';
    if (words.length > 1) return words.slice(0, 3).map(word => word[0]).join('').toUpperCase();
    return words[0].slice(0, 3).toUpperCase();
  }


  collapseSideBar() {
    if (window.innerWidth > 700) {
      this.bindersExpanded = this.labelsExpanded = false;
      return;
    }
    this.Shared.sideBarCollapsed.next(!this.Shared.sideBarCollapsed.value);
  }

  closeSideBarIfOpen() {
    if (window.innerWidth <= 700 && !this.Shared.sideBarCollapsed.value) this.Shared.sideBarCollapsed.next(true);
  }

  onNavItemClick() {
    this.closeSideBarIfOpen();
  }

  toggleTheme() {
    const nextTheme = this.auth.effectiveTheme === 'light' ? 'dark' : 'light'
    this.auth.updateTheme(nextTheme)
    this.onNavItemClick()
  }

  async logout() {
    try {
      if (await this.auth.logout()) return
    } catch (error) {
      const text = error instanceof Error && error.name === 'KeptServerResetError' ? error.message : 'Connect to the server to sign out.'
      ;(window as any).Snackbar?.show({ text, duration: 4000 })
      return
    }
    this.router.navigateByUrl('/login')
    this.onNavItemClick()
  }


  openInstallPwa() {
    if (this.Shared.deferredInstallPrompt) {
      const promptEvent = this.Shared.deferredInstallPrompt;
      this.Shared.deferredInstallPrompt = undefined;
      promptEvent.prompt();
      promptEvent.userChoice.finally(() => this.Shared.updateInstallVisibility());
      return;
    }
    this.installHelpOpen = true;
  }

  ngOnInit(): void {
    try {
      const paths: unknown = JSON.parse(localStorage.getItem(this.sectionStorageKey('binders') + ':paths') || '[]');
      if (Array.isArray(paths)) for (const path of paths) if (typeof path === 'string') this.expandedFolders.add(path);
    } catch { /* The tree is still usable without saved expansion. */ }
    this.bindersExpanded = this.readSectionExpanded('binders');
    this.labelsExpanded = this.readSectionExpanded('labels');
    this.subscriptions.push(
      this.Shared.closeSideBar.subscribe(x => { if (x) this.collapseSideBar() }),
      this.Shared.closeSideBarIfOpen.subscribe(x => { if (x) this.closeSideBarIfOpen() })
    );
  }

  ngOnDestroy() {
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.subscriptions = [];
    this.closeSideBarIfOpen();
  }

  private saveExpandedFolders() {
    try { localStorage.setItem(this.sectionStorageKey('binders') + ':paths', JSON.stringify([...this.expandedFolders])); }
    catch { /* Expansion remains active for this view. */ }
  }

  private sectionStorageKey(section: 'binders' | 'labels') {
    return `kept_sidebar_${section}_expanded:${this.auth.currentUser?.id || 'anon'}`;
  }

  private readSectionExpanded(section: 'binders' | 'labels') {
    try { return localStorage.getItem(this.sectionStorageKey(section)) === 'true'; }
    catch { return false; }
  }

  private saveSectionExpanded(section: 'binders' | 'labels', expanded: boolean) {
    try { localStorage.setItem(this.sectionStorageKey(section), String(expanded)); }
    catch { /* Sidebar remains usable when storage is blocked. */ }
  }

}
