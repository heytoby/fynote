const crypto = require('node:crypto');
const fs = require('node:fs');
const files = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { readTakeoutZip } = require('./takeout-zip');

const REPOSITORY = 'heytoby/fynote';
const RELEASES_URL = 'https://github.com/' + REPOSITORY + '/releases';
const LATEST_RELEASE_API = 'https://api.github.com/repos/' + REPOSITORY + '/releases/latest';
const VERSION = /^(?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){2}$/;
const MAX_PACKAGE_BYTES = 400 * 1024 * 1024;
const RESTART_EXIT_CODE = 42;
const SETUP_EXIT_CODE = 43;
const DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

function compareVersion(a, b) {
  const parts = version => String(version || '').replace(/^v/i, '').split('-')[0].split('.').map(Number);
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function parseRelease(release) {
  const tag = release?.tag_name;
  const version = typeof tag === 'string' && tag.startsWith('v') ? tag.slice(1) : '';
  if (!VERSION.test(version) || release.draft || release.prerelease) return null;

  const assets = Array.isArray(release.assets) ? release.assets : [];
  function verifiedAsset(filename) {
    const url = RELEASES_URL + '/download/' + tag + '/' + filename;
    const asset = assets.find(item => item && item.name === filename &&
      item.browser_download_url === url && item.state === 'uploaded' &&
      Number.isSafeInteger(item.size) && item.size > 0 && item.size <= MAX_PACKAGE_BYTES &&
      /^sha256:[a-f0-9]{64}$/i.test(item.digest || ''));
    return asset ? { url, size: asset.size, sha256: asset.digest.slice(7).toLowerCase() } : null;
  }

  return {
    version,
    url: RELEASES_URL + '/tag/' + tag,
    notes: String(release.body || '').slice(0, 5000),
    publishedAt: release.published_at || null,
    windows: verifiedAsset('fynote-' + version + '-windows-x64.zip'),
    setup: verifiedAsset('fynote-Setup-' + version + '.exe')
  };
}

function installationRoot(root, version, applicationDirectory) {
  if (!root || !VERSION.test(version)) return null;
  const resolved = path.resolve(root);
  const expected = path.join(resolved, 'versions', version, 'app');
  return path.relative(expected, path.resolve(applicationDirectory)) === '' ? resolved : null;
}

async function fetchPackage(asset, destination, fetchImpl, onProgress) {
  const signal = AbortSignal.timeout(15 * 60 * 1000);
  let url = new URL(asset.url);
  let response;
  for (let hop = 0; hop < 5; hop++) {
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !DOWNLOAD_HOSTS.has(url.hostname)) {
      throw new Error('更新下载地址不在允许的 GitHub 域名中。');
    }
    response = await fetchImpl(url, {
      redirect: 'manual',
      signal,
      headers: { 'User-Agent': 'Fynote Desktop', Accept: 'application/octet-stream' }
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('GitHub 未返回有效的下载地址。');
    url = new URL(location, url);
  }
  if (!response?.ok || !response.body) throw new Error('GitHub 更新包下载失败。');

  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const verify = new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > asset.size) return done(new Error('更新包大小与发布记录不符。'));
      hash.update(chunk);
      onProgress?.(bytes, asset.size);
      done(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body), verify, fs.createWriteStream(destination, { flags: 'wx' }), { signal });
  if (bytes !== asset.size || hash.digest('hex') !== asset.sha256) {
    throw new Error('更新包校验失败，请重新检查更新。');
  }
}

function payloadPath(name, prefix) {
  if (!name.startsWith(prefix)) return null;
  const relative = name.slice(prefix.length).replace(/\/$/, '');
  if (!relative) return null;
  const parts = relative.split('/');
  if (!['app', 'runtime'].includes(parts[0]) || parts.some(part =>
    !part || part === '.' || part === '..' || /[<>:"\\|?*\x00-\x1f]/.test(part) ||
    /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
  )) throw new Error('更新包包含无效的 Windows 文件路径。');
  return parts;
}

async function extractPayload(archivePath, payload, version) {
  const archive = await readTakeoutZip(archivePath, { maxTotalBytes: 1536 * 1024 * 1024 });
  const prefix = 'fynote/versions/' + version + '/';
  try {
    for (const entry of archive.entries) {
      const parts = payloadPath(entry.entryName, prefix);
      if (!parts) continue;
      const destination = path.join(payload, ...parts);
      if (entry.isDirectory) {
        await files.mkdir(destination, { recursive: true });
      } else {
        await files.mkdir(path.dirname(destination), { recursive: true });
        await files.writeFile(destination, await entry.getData(), { flag: 'wx' });
      }
    }
  } finally {
    await archive.close();
  }
}

async function checkPayload(directory, version) {
  const manifest = JSON.parse(await files.readFile(path.join(directory, 'app', 'package.json'), 'utf8'));
  if (manifest.version !== version) throw new Error('更新包中的应用版本不符。');
  for (const name of ['runtime/node.exe', 'app/server/server.js', 'app/dist/keep/index.html']) {
    const stat = await files.stat(path.join(directory, name));
    if (!stat.isFile() || !stat.size) throw new Error('更新包缺少启动文件。');
  }
}

async function switchVersion(root, version, previousVersion) {
  const temporary = path.join(root, '.current-' + crypto.randomUUID() + '.json');
  try {
    await files.writeFile(temporary, JSON.stringify({ version, previousVersion }) + '\n', { flag: 'wx' });
    await files.rename(temporary, path.join(root, 'current.json'));
  } finally {
    await files.rm(temporary, { force: true }).catch(() => {});
  }
}

async function installRelease(root, currentVersion, release, fetchImpl = fetch) {
  const version = release?.version;
  const asset = release?.windows;
  if (!VERSION.test(currentVersion) || !VERSION.test(version || '') ||
      compareVersion(version, currentVersion) <= 0 || !asset) {
    throw new Error('该版本没有可安装的 Windows 更新。');
  }
  const versions = path.join(root, 'versions');
  const destination = path.join(versions, version);
  const scratch = await files.mkdtemp(path.join(versions, '.download-'));
  try {
    const active = JSON.parse(await files.readFile(path.join(root, 'current.json'), 'utf8'));
    if (active.version !== currentVersion) throw new Error('已有更新等待重启。');
    const archive = path.join(scratch, 'update.zip');
    const payload = path.join(scratch, 'payload');
    await fetchPackage(asset, archive, fetchImpl);
    await extractPayload(archive, payload, version);
    await checkPayload(payload, version);
    await files.writeFile(path.join(payload, '.release-sha256'), asset.sha256, { flag: 'wx' });
    try {
      await files.rename(payload, destination);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
      const existing = await files.readFile(path.join(destination, '.release-sha256'), 'utf8').catch(() => '');
      if (existing !== asset.sha256) throw new Error('更新目录已存在，无法安全覆盖。');
      await checkPayload(destination, version);
    }
    await switchVersion(root, version, currentVersion);
  } finally {
    // mkdtemp created this exact directory immediately under the version store.
    if (path.dirname(scratch) === path.resolve(versions)) {
      await files.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function stageSetup(root, asset, fetchImpl = fetch, onProgress) {
  const directory = path.join(root, '.update');
  await files.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, crypto.randomUUID() + '.exe');
  try {
    await fetchPackage(asset, temporary, fetchImpl, onProgress);
    await files.rename(temporary, path.join(directory, 'setup.exe'));
  } finally {
    await files.rm(temporary, { force: true });
  }
}

module.exports = { stageSetup, SETUP_EXIT_CODE, compareVersion, installationRoot, installRelease, LATEST_RELEASE_API, parseRelease, RESTART_EXIT_CODE };
