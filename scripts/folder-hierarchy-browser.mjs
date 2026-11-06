import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

const fixture = await startFixture();
let browser;
try {
  const credentials = { username: 'folder-goal', displayName: 'Folder Goal', password: 'isolated-folder-test-password' };
  let token;
  async function api(path, data) {
    const response = await fetch(fixture.origin + '/api' + path, {
      method: data ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: data ? JSON.stringify(data) : undefined
    });
    assert.ok(response.ok, await response.clone().text());
    return response.status === 204 ? null : response.json();
  }
  await api('/setup/admin', credentials);
  token = (await api('/auth/login', credentials)).token;
  await api('/users/me/mark-demo-notes-created', {});
  browser = await chromium.launch({ executablePath: process.env.FYNOTE_CHROMIUM || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const session = await (await context.request.get(fixture.origin + '/api/auth/browser/session')).json();
  assert.ok((await context.request.post(fixture.origin + '/api/auth/browser/login', {
    data: credentials, headers: { 'X-CSRF-Token': session.csrfToken, Origin: fixture.origin }
  })).ok());
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(fixture.origin);

  const sidebar = page.locator('#fynote-sidebar');
  await sidebar.getByRole('button', { name: '文件夹', exact: true }).click();
  const dialog = page.locator('.modal-container:visible').filter({ has: page.getByPlaceholder('新建文件夹') });
  async function createFolder(name) {
    const field = dialog.getByPlaceholder('新建文件夹');
    await field.fill(name);
    await field.press('Enter');
    await dialog.getByRole('textbox').filter({ visible: true }).first().evaluate(input =>
      new Promise(resolve => {
        if (!input.value) return resolve();
        const timer = setInterval(() => {
          if (!input.value) { clearInterval(timer); resolve(); }
        }, 50);
        setTimeout(() => { clearInterval(timer); resolve(); }, 5000);
      }));
    assert.equal(await field.inputValue(), '');
    await dialog.getByText('完成', { exact: true }).click();
  }
  await sidebar.locator('.binder-add-btn').click();
  const root = 'Project';
  await createFolder(root);
  let path = root;
  for (const name of ['Stage', 'Design', 'Assets', 'Final']) {
    const row = sidebar.locator('.folder-tree-row').filter({ has: page.locator('[data-binder-drop=' + JSON.stringify(path) + ']') });
    await row.getByRole('button', { name: '新建子文件夹' }).click();
    await createFolder(name);
    path += '␟' + name;
  }

  const parentNote = await api('/notes', { noteTitle: 'Root only note', binder: root });
  const childNote = await api('/notes', { noteTitle: 'Deep folder note', binder: path });
  await page.reload();
  await sidebar.getByRole('button', { name: '文件夹', exact: true }).waitFor();
  const toggle = sidebar.getByRole('button', { name: '文件夹', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await sidebar.locator('[data-binder-drop="Project"]').click();
  await page.locator(`[data-note-id="${parentNote.id}"]`).first().waitFor();
  assert.equal(await page.locator(`[data-note-id="${childNote.id}"]`).count(), 0);
  await page.getByRole('button', { name: /筛选/ }).click();
  await page.getByRole('button', { name: '含子文件夹', exact: true }).click();
  await page.locator(`[data-note-id="${childNote.id}"]`).first().waitFor();
  assert.ok(await sidebar.isVisible());
  const language = page.getByRole('button', { name: '切换语言 / Switch language' });
  await language.click();
  await sidebar.getByRole('button', { name: 'Folders', exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  await language.click();
  await sidebar.getByRole('button', { name: '文件夹', exact: true }).waitFor();
  console.log('Goal acceptance passed: create nested folders, reload, exact scope, descendant scope, sidebar remains visible.');
} finally {
  await browser?.close();
  await fixture.close();
}
