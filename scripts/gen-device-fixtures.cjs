'use strict';

/*
 * Synthetic device-catalogue fixtures: a deterministic plan of invented file names (board codes, revisions, role words, accents,
 * case and Unicode variants, sidecar files, hidden files, uncertain and missing cases, a deep path) with the truth for each one.
 * Only invented names and tiny text bodies are produced; no board, schematic or firmware content is read or copied.
 *
 *   node scripts/gen-device-fixtures.cjs --out=<empty dir outside this repository> [--seed=<text>] [--json]
 *
 * planFixtures(seed) is pure: the same seed gives the same plan and the same bytes on every platform.
 * survivingEntries(plan, platform) models which entries a file system of that platform keeps when two names collide:
 *   win32  case-insensitive, names kept as written (NFC and NFD are different names on NTFS)
 *   linux  case-sensitive, names kept as written
 *   darwin case-insensitive and assumed normalisation-insensitive (NFC and NFD are one name). Not verified on the win32 host; needs a native macOS run.
 * writeFixtures(out, seed) writes the real files. A name that already resolves on the host is skipped and recorded, so a
 * collision is never overwritten. The real file system decides what exists; the manifest says what was written.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_SEED = 'device-fixtures-1';
const MARKER = 'trace-device-fixtures';

/** FNV-1a hash of the seed text, then mulberry32: small, dependency free, the same on every platform. */
function makeRandom(seedText) {
  let hash = 0x811c9dc5;
  for (const char of String(seedText)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let state = hash;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function truth(kind, fields = {}) {
  return { kind, boardCode: null, codes: [], revision: null, aliasesMustInclude: [], sidecar: false, hidden: false, ...fields };
}

/** The plan: ordered entries { scenario, path, truth } with the path as written (canonical "/" separators). */
function planEntries() {
  const AGNES_FOLDER = 'Ágnes Böngésző'.normalize('NFC');
  const deep = Array.from({ length: 10 }, (_value, index) => `level-${String(index).padStart(2, '0')}-synthetic-folder-name`);
  return [
    // S1 to S4: four conventions of one board (MB-Q731); the folder gives revision 2.
    { scenario: 'S1', path: 'Birchfield/Kestrel-14-R2/MB-Q731_rev2.brd', truth: truth('boardview', { boardCode: 'MB-Q731', codes: ['MB-Q731'], revision: '2', aliasesMustInclude: ['birchfield', 'kestrel'] }) },
    { scenario: 'S2', path: 'Birchfield/Kestrel-14-R2/MB Q731 rev 2 copy.brd', truth: truth('boardview', { boardCode: 'MB-Q731', codes: ['MB-Q731'], revision: '2', aliasesMustInclude: ['birchfield'] }) },
    { scenario: 'S3', path: 'Birchfield/Kestrel-14-R2/mb-q731 REV02.BRD', truth: truth('boardview', { boardCode: 'MB-Q731', codes: ['MB-Q731'], revision: '2' }) },
    { scenario: 'S4', path: 'Birchfield/Kestrel-14-R2/MBQ731.brd', truth: truth('boardview', { boardCode: 'MB-Q731', codes: ['MB-Q731'], revision: '2', aliasesMustInclude: ['mbq731'] }) },
    // S5: a schematic whose name has no board code: it can only be linked by alias.
    { scenario: 'S5', path: 'Birchfield/Kestrel-14-R2/docs/Kestrel14_R02_schematic.pdf', truth: truth('schematic', { revision: '2', aliasesMustInclude: ['kestrel14'] }) },
    // S6 to S8: firmware candidates; they are never a BIOS by name alone.
    { scenario: 'S6', path: 'Alder/Orion-5/MB-Q731_rev2_BIOS.bin', truth: truth('bios-candidate', { boardCode: 'MB-Q731', codes: ['MB-Q731'], revision: '2' }) },
    { scenario: 'S7', path: 'Alder/Orion-5/MB-Q731_rev2_EC.bin', truth: truth('ec-firmware', { boardCode: 'MB-Q731', codes: ['MB-Q731'], revision: '2' }) },
    { scenario: 'S8', path: 'Alder/Orion-5/MB-Q731_dump.rom', truth: truth('saved-dump', { boardCode: 'MB-Q731', codes: ['MB-Q731'] }) },
    // S9: two revisions of one board in one folder (multiple matches; both are probable, not confirmed).
    { scenario: 'S9', path: 'Tessaly/Mirror/BD-K1402_rev1.brd', truth: truth('boardview', { boardCode: 'BD-K1402', codes: ['BD-K1402'], revision: '1' }) },
    { scenario: 'S9', path: 'Tessaly/Mirror/BD-K1402_rev3.brd', truth: truth('boardview', { boardCode: 'BD-K1402', codes: ['BD-K1402'], revision: '3' }) },
    // S10: accents in the folder and file name. The second name is written in decomposed form (NFD) on purpose.
    { scenario: 'S10', path: AGNES_FOLDER + '/LB-N77 Ágnes.brd'.normalize('NFC'), truth: truth('boardview', { boardCode: 'LB-N77', codes: ['LB-N77'], aliasesMustInclude: ['agnes', 'bongeszo'] }) },
    { scenario: 'S10', path: AGNES_FOLDER + '/' + 'LB-N77 Ágnes.brd'.normalize('NFD'), truth: truth('boardview', { boardCode: 'LB-N77', codes: ['LB-N77'], aliasesMustInclude: ['agnes'] }) },
    // S11: the same name in another letter case. Two names that differ only by case are one file on win32 and darwin.
    { scenario: 'S11', path: 'Quarrel/case/lb-n77_rev2.BRD', truth: truth('boardview', { boardCode: 'LB-N77', codes: ['LB-N77'], revision: '2' }) },
    { scenario: 'S11', path: 'Quarrel/case/LB-N77_REV2.brd', truth: truth('boardview', { boardCode: 'LB-N77', codes: ['LB-N77'], revision: '2' }) },
    // S12 to S14: uncertain cases. Two codes in one name, a generic name, and a name with only the folder alias.
    { scenario: 'S12', path: 'Quarrel/uncertain/MB-Q731 vs MB-Q732.brd', truth: truth('boardview', { codes: ['MB-Q731', 'MB-Q732'], aliasesMustInclude: ['quarrel'] }) },
    { scenario: 'S13', path: 'Quarrel/uncertain/board.brd', truth: truth('boardview', { aliasesMustInclude: ['quarrel'] }) },
    { scenario: 'S14', path: 'Quarrel/uncertain/Quarrel-untitled.brd', truth: truth('boardview', { aliasesMustInclude: ['quarrel', 'untitled'] }) },
    // S15: a firmware file whose board has no board file in the library (missing match).
    { scenario: 'S15', path: 'Orphan/MB-Z999_BIOS.bin', truth: truth('bios-candidate', { boardCode: 'MB-Z999', codes: ['MB-Z999'] }) },
    // S16: sidecar and hidden files. Operating systems write these next to the user's files.
    { scenario: 'S16', path: 'Sidecars/._MB-Q731_rev2.brd', truth: truth('boardview', { sidecar: true, hidden: true, boardCode: 'MB-Q731', codes: ['MB-Q731'], revision: '2' }) },
    { scenario: 'S16', path: 'Sidecars/.DS_Store', truth: truth('other', { sidecar: true, hidden: true }) },
    { scenario: 'S16', path: 'Sidecars/Thumbs.db', truth: truth('other', { sidecar: true }) },
    { scenario: 'S16', path: 'Sidecars/desktop.ini', truth: truth('other', { sidecar: true }) },
    { scenario: 'S16', path: 'Sidecars/.LB-N77_hidden.brd', truth: truth('boardview', { hidden: true, boardCode: 'LB-N77', codes: ['LB-N77'] }) },
    // S17 and S18: non-Latin and stroke letters. Search keys must not lose them (Cyrillic) or fold them badly (Polish).
    { scenario: 'S17', path: 'Плата/Кестрел-14/Кестрел-14_rev2.brd', truth: truth('boardview', { revision: '2', aliasesMustInclude: ['кестрел'] }) },
    { scenario: 'S18', path: 'Łódź/Łącznik-7/Łącznik-7.brd', truth: truth('boardview', { aliasesMustInclude: ['lodz'] }) },
    // S19: a deep path, longer than 260 characters, with a board code in the name.
    { scenario: 'S19', path: [...deep, 'BD-K1402_rev3_deep.brd'].join('/'), truth: truth('boardview', { boardCode: 'BD-K1402', codes: ['BD-K1402'], revision: '3' }) },
    // S20: brackets, parentheses, ampersand, hash and dots: all legal on the three platforms.
    { scenario: 'S20', path: 'Tessaly/Symbols/[LB-N77] (rev 2) & friends #1.v2.brd', truth: truth('boardview', { boardCode: 'LB-N77', codes: ['LB-N77'], revision: '2' }) },
    // S21: a hidden placeholder file inside a folder that holds nothing else.
    { scenario: 'S21', path: 'Empty/.keep', truth: truth('other', { hidden: true }) },
  ];
}

/** The content of one entry: a tiny synthetic text, its length chosen by the seed. */
function contentOf(entryIndex, seedText, random) {
  const size = 64 + Math.floor(random() * 192);
  const head = `SYNTHETIC device fixture; seed=${seedText}; entry=${entryIndex}\n`;
  return head + 'x'.repeat(Math.max(0, size - head.length));
}

/** The full plan for a seed: entries with their bytes. Pure; no file system access. */
function planFixtures(seed = DEFAULT_SEED) {
  const seedText = String(seed);
  const random = makeRandom(seedText);
  const entries = planEntries().map((entry, index) => ({ ...entry, index, content: contentOf(index, seedText, random) }));
  return { seed: seedText, entries };
}

/** The key a file system of `platform` uses to decide that two names are the same file. Model, see the header. */
function collisionKey(name, platform) {
  if (platform === 'linux') return name;
  if (platform === 'darwin') return name.normalize('NFC').toLowerCase();
  return name.toLowerCase();
}

/** The entries a file system of `platform` keeps: the first name of each collision class wins, in plan order. */
function survivingEntries(plan, platform) {
  const seen = new Set();
  const kept = [];
  for (const entry of plan.entries) {
    const key = collisionKey(entry.path, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(entry);
  }
  return kept;
}

/** The directory tree of a list of entries as a read-only in-memory port (same shape as the real one). */
function memoryTree(entries) {
  const tree = new Map([['', []]]);
  const names = (folder) => {
    if (!tree.has(folder)) tree.set(folder, []);
    return tree.get(folder);
  };
  for (const entry of entries) {
    const segments = entry.path.split('/');
    for (let depth = 0; depth < segments.length - 1; depth++) {
      const parent = segments.slice(0, depth).join('/');
      const folder = segments.slice(0, depth + 1).join('/');
      if (!names(parent).some(item => item.name === segments[depth])) names(parent).push({ name: segments[depth], kind: 'dir' });
      names(folder);
    }
    names(segments.slice(0, -1).join('/')).push({ name: segments[segments.length - 1], kind: 'file', size: Buffer.byteLength(entry.content) });
  }
  return {
    async readDir(segments) {
      const key = segments.join('/');
      if (!tree.has(key)) throw new Error('ENOENT synthetic');
      return tree.get(key);
    },
  };
}

function realOrSelf(target) {
  try { return fs.realpathSync.native(target); } catch { return path.resolve(target); }
}

/** Throws unless `out` can take a new fixture folder: outside this repository and missing or empty. */
function checkOutput(out) {
  const target = path.resolve(out);
  const where = realOrSelf(target);
  const repo = realOrSelf(REPO);
  const inside = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
  if (inside(repo, where) || inside(repo, target)) throw new Error(`--out ${target} is inside the repository; fixtures are never kept in it`);
  if (inside(where, repo)) throw new Error(`--out ${target} contains the repository`);
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) throw new Error(`--out ${target} is not empty`);
  return target;
}

/**
 * Writes the fixtures under <out>/library and <out>/manifest.json. Each entry is written only when its name does not already
 * resolve on this host; otherwise it is recorded in `skipped` with the name that already exists.
 */
function writeFixtures(out, seed = DEFAULT_SEED) {
  const target = checkOutput(out);
  const plan = planFixtures(seed);
  const library = path.join(target, 'library');
  fs.mkdirSync(library, { recursive: true });
  const created = [];
  const skipped = [];
  for (const entry of plan.entries) {
    const file = path.join(library, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      skipped.push({ scenario: entry.scenario, path: entry.path, reason: 'name-resolves-to-existing-entry' });
      continue;
    }
    fs.writeFileSync(file, entry.content, { flag: 'wx' });
    created.push({ scenario: entry.scenario, path: entry.path, size: Buffer.byteLength(entry.content) });
  }
  const manifest = { marker: MARKER, seed: plan.seed, host: process.platform, planned: plan.entries.length, created, skipped };
  fs.writeFileSync(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { out: target, library, manifest };
}

module.exports = { MARKER, DEFAULT_SEED, makeRandom, planFixtures, survivingEntries, collisionKey, memoryTree, checkOutput, writeFixtures };

if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    return match ? [match[1], match[2] ?? true] : [arg, true];
  }));
  if (typeof args.out !== 'string') {
    console.error('usage: node scripts/gen-device-fixtures.cjs --out=<empty dir outside the repository> [--seed=<text>] [--json]');
    process.exit(2);
  }
  const result = writeFixtures(args.out, typeof args.seed === 'string' ? args.seed : DEFAULT_SEED);
  if (args.json) console.log(JSON.stringify(result.manifest, null, 2));
  else console.log(`wrote ${result.manifest.created.length} of ${result.manifest.planned} synthetic entries to ${result.library} (skipped ${result.manifest.skipped.length})`);
}
