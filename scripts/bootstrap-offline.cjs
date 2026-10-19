// Emergency local verification helper for the restricted hackathon environment.
// This is NOT a replacement for pnpm install and never fabricates missing packages.
// Extracts only cached tarballs, preserves their real versions, and reports gaps.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const npmRoot = process.env.ENSEMBLE_NPM_ROOT || '/home/mehdi/.nvm/versions/node/v24.14.0/lib/node_modules/npm';
const cacache = require(path.join(npmRoot, 'node_modules/cacache'));
const tar = require(path.join(npmRoot, 'node_modules/tar'));
const semver = require(path.join(npmRoot, 'node_modules/semver'));
const cache = process.env.ENSEMBLE_NPM_CACHE || '/home/mehdi/.npm/_cacache';
const output = process.env.ENSEMBLE_OFFLINE_PACKAGES || '/tmp/ensemble-offline-packages';
const nodeModules = path.resolve('node_modules');
const installed = new Map(), archives = new Map(), jobs = new Map(), missing = new Set();
const queue = [];

async function link(target, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try { await fs.symlink(target, destination, 'dir'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
function add(map, name, record) { map.set(name, [...(map.get(name) || []), record]); }
function matching(candidates, range) {
  return candidates?.filter(record => semver.satisfies(record.version, range, { includePrerelease: true }))
    .sort((a, b) => semver.rcompare(a.version, b.version))[0];
}
function ensure(name, range, optional = false) {
  const existing = matching(installed.get(name), range);
  if (existing) return existing.directory;
  const archive = matching(archives.get(name), range);
  if (!archive) { if (!optional) missing.add(`${name}@${range}`); return undefined; }
  const key = `${name}@${archive.version}`;
  const directory = path.join(output, name.replace('/', '__'), archive.version);
  if (!jobs.has(key)) { jobs.set(key, directory); queue.push({ name, archive, directory }); }
  return directory;
}
async function install(job) {
  await fs.mkdir(job.directory, { recursive: true });
  try { await fs.access(path.join(job.directory, 'package.json')); }
  catch {
    const bytes = await cacache.get.byDigest(cache, job.archive.integrity);
    const stream = tar.x({ cwd: job.directory, strip: 1 });
    await new Promise((resolve, reject) => { stream.on('error', reject); stream.on('close', resolve); stream.end(bytes); });
  }
  const manifest = JSON.parse(await fs.readFile(path.join(job.directory, 'package.json'), 'utf8'));
  for (const [name, range] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    const target = ensure(name, range, Boolean(manifest.optionalDependencies?.[name]));
    if (target) await link(target, path.join(job.directory, 'node_modules', name));
  }
  // Peer dependencies resolve from this package's own node_modules too, since its
  // realpath is in /tmp rather than inside the project's normal dependency tree.
  for (const [name, range] of Object.entries(manifest.peerDependencies || {})) {
    const target = ensure(name, range, true);
    if (target) await link(target, path.join(job.directory, 'node_modules', name));
  }
}
(async () => {
  const roots = [
    '/home/mehdi/.npm/_npx',
    '/tmp/claude-1000/-home-mehdi-cline-hackathon/e505d838-c7ef-40f2-a178-413ce6750c65/scratchpad/sdkpkg/node_modules',
    '/tmp/claude-1000/-home-mehdi-cline-hackathon/e505d838-c7ef-40f2-a178-413ce6750c65/scratchpad/sdkprobe/node_modules',
  ];
  const search = spawnSync('rg', ['--files', '--hidden', '--no-ignore', ...roots], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  for (const file of search.stdout.split('\n').filter(file => file.endsWith('/package.json'))) {
    try {
      const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
      if (manifest.name && semver.valid(manifest.version)) add(installed, manifest.name, { version: manifest.version, directory: path.dirname(file) });
    } catch {}
  }
  for (const [key, entry] of Object.entries(await cacache.ls(cache))) {
    if (!key.endsWith('.tgz') || !key.includes('registry.npmjs.org/')) continue;
    const pathname = decodeURIComponent(key.split('registry.npmjs.org/')[1]);
    const split = pathname.split('/-/');
    if (split.length !== 2) continue;
    const name = split[0], basename = name.split('/').at(-1);
    const version = split[1].slice(basename.length + 1, -4);
    if (semver.valid(version)) add(archives, name, { version, integrity: entry.integrity });
  }
  await fs.mkdir(nodeModules, { recursive: true });
  const manifest = JSON.parse(await fs.readFile('package.json', 'utf8'));
  for (const [name, range] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const target = ensure(name, range);
    if (target) await link(target, path.join(nodeModules, name));
  }
  while (queue.length) {
    const batch = queue.splice(0, 8);
    await Promise.all(batch.map(install));
  }
  await fs.mkdir(path.join(nodeModules, '.bin'), { recursive: true });
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    try {
      const location = path.join(nodeModules, name);
      const packageJSON = JSON.parse(await fs.readFile(path.join(location, 'package.json'), 'utf8'));
      const bins = typeof packageJSON.bin === 'string' ? { [name.split('/').at(-1)]: packageJSON.bin } : packageJSON.bin || {};
      for (const [bin, relative] of Object.entries(bins)) await link(path.join(location, relative), path.join(nodeModules, '.bin', bin));
    } catch {}
  }
  console.log(`Prepared ${jobs.size} cached package versions for offline verification.`);
  console.log('Missing required packages:\n' + [...missing].sort().join('\n'));
  if (missing.size) process.exitCode = 2;
})().catch(error => { console.error(error); process.exitCode = 1; });
