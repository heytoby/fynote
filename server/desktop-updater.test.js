const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const files = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { ZipWriter, Uint8ArrayWriter, TextReader } = require('@zip.js/zip.js');
const { compareVersion, installationRoot, installRelease, parseRelease, stageSetup } = require('./desktop-updater');

const current = '1.9.4';
const next = '1.9.5';
const packageName = 'fynote-' + next + '-windows-x64.zip';
const packageUrl = 'https://github.com/heytoby/fynote/releases/download/v' + next + '/' + packageName;

function releaseWith(bytes, overrides = {}) {
  return {
    tag_name: 'v' + next,
    draft: false,
    prerelease: false,
    assets: [{
      name: packageName,
      state: 'uploaded',
      browser_download_url: packageUrl,
      size: bytes.length,
      digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'),
      ...overrides
    }]
  };
}

async function updateZip(extra = {}) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  const prefix = 'fynote/versions/' + next + '/';
  for (const [file, content] of Object.entries({
    'app/package.json': JSON.stringify({ version: next }),
    'app/server/server.js': 'console.log("ready");',
    'app/dist/keep/index.html': '<app-root></app-root>',
    'runtime/node.exe': 'test runtime',
    ...extra
  })) {
    await writer.add(prefix + file, new TextReader(content));
  }
  return Buffer.from(await writer.close());
}

async function installation(t) {
  const temp = path.resolve(process.env.FYNOTE_TEST_TMPDIR || os.tmpdir());
  const root = await files.mkdtemp(path.join(temp, 'fynote-update-test-'));
  t.after(async () => {
    if (path.dirname(root) === temp) await files.rm(root, { recursive: true, force: true });
  });
  await files.mkdir(path.join(root, 'versions', current, 'app'), { recursive: true });
  await files.mkdir(path.join(root, 'user-data'));
  await files.writeFile(path.join(root, 'user-data', 'notes.sqlite'), 'original notes');
  await files.writeFile(path.join(root, 'current.json'), JSON.stringify({ version: current }));
  return root;
}

async function selectedVersion(root) {
  return JSON.parse(await files.readFile(path.join(root, 'current.json'), 'utf8'));
}

test('patch updates sort correctly and the Windows package must come from the expected release', () => {
  assert.equal(compareVersion('1.9.4', '1.9.3'), 1);
  assert.equal(compareVersion('v1.9.9', '1.9.10'), -1);
  assert.equal(compareVersion('1.10.0', '1.9.11'), 1);
  const release = releaseWith(Buffer.from('test'));
  assert.equal(parseRelease(release).windows.url, packageUrl);
  assert.equal(parseRelease({ ...release, prerelease: true }), null);
  assert.equal(parseRelease(releaseWith(Buffer.from('test'), { digest: null })).windows, null);
  assert.equal(parseRelease(releaseWith(Buffer.from('test'), { browser_download_url: 'https://example.org/file.zip' })).windows, null);
});

test('a verified update stages a full version before switching and preserves user data', async t => {
  const root = await installation(t);
  const bytes = await updateZip();
  const release = parseRelease(releaseWith(bytes));
  const downloadHosts = [];
  await installRelease(root, current, release, async url => {
    downloadHosts.push(url.hostname);
    if (url.hostname === 'github.com') {
      return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset' } });
    }
    return new Response(bytes);
  });
  assert.deepEqual(downloadHosts, ['github.com', 'release-assets.githubusercontent.com']);
  assert.equal(installationRoot(root, next, path.join(root, 'versions', next, 'app')), root);
  assert.equal(installationRoot(root, next, path.join(root, 'other-app')), null);
  assert.deepEqual(await selectedVersion(root), { version: next, previousVersion: current });
  assert.equal(await files.readFile(path.join(root, 'user-data', 'notes.sqlite'), 'utf8'), 'original notes');
  assert.deepEqual((await files.readdir(path.join(root, 'versions'))).sort(), [current, next]);
});

test('wrong digests, unexpected download hosts and invalid archive paths leave the current version active', async t => {
  const root = await installation(t);
  const bytes = await updateZip();
  const wrongDigest = parseRelease(releaseWith(bytes, { digest: 'sha256:' + '0'.repeat(64) }));
  await assert.rejects(installRelease(root, current, wrongDigest, async () => new Response(bytes)), /校验失败/);

  const release = parseRelease(releaseWith(bytes));
  let requests = 0;
  await assert.rejects(installRelease(root, current, release, async () => {
    requests++;
    return new Response(null, { status: 302, headers: { location: 'https://example.org/file.zip' } });
  }), /允许的 GitHub 域名/);
  assert.equal(requests, 1);

  const invalid = await updateZip({ 'app/AUX.txt': 'reserved Windows device' });
  await assert.rejects(installRelease(root, current, parseRelease(releaseWith(invalid)), async () => new Response(invalid)), /无效的 Windows 文件路径/);
  assert.deepEqual(await selectedVersion(root), { version: current });
  assert.deepEqual(await files.readdir(path.join(root, 'versions')), [current]);
});

test('retrying a previously staged package reuses its verified version', async t => {
  const root = await installation(t);
  const bytes = await updateZip();
  const release = parseRelease(releaseWith(bytes));
  await installRelease(root, current, release, async () => new Response(bytes));
  // Simulate a valid payload already staged before the version pointer moved.
  await files.writeFile(path.join(root, 'current.json'), JSON.stringify({ version: current }));
  await installRelease(root, current, release, async () => new Response(bytes));
  assert.deepEqual(await selectedVersion(root), { version: next, previousVersion: current });
});

test('installed Windows updates stage only the verified release EXE', async t => {
  const root = await installation(t);
  const bytes = Buffer.from('installer fixture');
  const name = 'fynote-Setup-' + next + '.exe';
  const url = new URL(name, packageUrl).href;
  const release = parseRelease(releaseWith(bytes, { name, browser_download_url: url }));
  assert.equal(release.setup.url, url);
  assert.equal(release.windows, null);
  const destination = path.join(root, '.update', 'setup.exe');
  await assert.rejects(stageSetup(root, release.setup, async () => new Response(Buffer.alloc(bytes.length))), /校验失败/);
  await assert.rejects(files.stat(destination), { code: 'ENOENT' });
  const progress = [];
  await stageSetup(root, release.setup, async () => new Response(bytes), (received, total) => {
    progress.push({ received, total });
  });
  assert.deepEqual(progress.at(-1), { received: bytes.length, total: bytes.length });
  assert.deepEqual(await files.readFile(destination), bytes);
  assert.deepEqual(await selectedVersion(root), { version: current });
});
