'use strict';

// Writes the two sidecar files that the packaged QA harness reads (scripts/packaged-functional-qa.cjs: --checksum and --manifest) for a
// local build folder whose build skipped the CI steps that make them. Every value is computed from the real files: the portable EXE's
// SHA-256 in the same "hash  name" line the windows.yml release job writes, and the per-file payload manifest of the unpacked app that
// scripts/payload-manifest.cjs writes. This script checks nothing and accepts no build; the QA harness still verifies every value.

const { createHash } = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const payloadManifest = require('./payload-manifest.cjs');

const USAGE = 'Usage: node scripts/write-build-sidecars.cjs --exe <TRACE-Boardviewer-x.exe> --unpacked <win-unpacked> [--out-dir <dir>] [--flavour release|qa]\n'
  + 'Writes <exe>.sha256 and <out-dir>/payload-manifest.json. --out-dir defaults to the EXE folder and must be outside --unpacked.\n'
  + '--flavour qa names the main executable "TRACE Boardviewer QA.exe" in the manifest (the QA build); release is the default.';

class SidecarError extends Error {}

function parseArgs(argv) {
  const options = { exe: null, unpacked: null, outDir: null, flavour: 'release', help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    const take = () => {
      if (equals > 0) return arg.slice(equals + 1);
      if (index + 1 >= argv.length) throw new SidecarError(`${flag} needs a value.`);
      return argv[++index];
    };
    switch (flag) {
      case '--exe': options.exe = take(); break;
      case '--unpacked': options.unpacked = take(); break;
      case '--out-dir': options.outDir = take(); break;
      case '--flavour': options.flavour = take(); break;
      case '--help': case '-h': options.help = true; break;
      default: throw new SidecarError(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

/** Writes the checksum last, so its presence means the manifest was written too. */
async function writeBuildSidecars({ exe, unpacked, outDir = null, flavour = 'release' }, { log = console.log } = {}) {
  if (!exe || !unpacked) throw new SidecarError('--exe and --unpacked are required.');
  const exePath = path.resolve(exe);
  const unpackedPath = path.resolve(unpacked);
  const outPath = path.resolve(outDir || path.dirname(exePath));
  if (!(await fsp.stat(exePath).catch(() => null))?.isFile()) throw new SidecarError(`the portable EXE is missing: ${exePath}`);
  if (!(await fsp.stat(unpackedPath).catch(() => null))?.isDirectory()) throw new SidecarError(`the unpacked app folder is missing: ${unpackedPath}`);

  const manifestPath = path.join(outPath, 'payload-manifest.json');
  const errors = [];
  const code = await payloadManifest.main(['--dir', unpackedPath, '--out', manifestPath, '--flavour', flavour], { log, error: message => errors.push(message) });
  if (code !== payloadManifest.EXIT.OK) throw new SidecarError(errors.join('\n') || 'the payload manifest could not be written');

  const hash = createHash('sha256').update(await fsp.readFile(exePath)).digest('hex');
  await fsp.writeFile(`${exePath}.sha256`, `${hash}  ${path.basename(exePath)}\n`, 'ascii');
  log(`checksum: ${exePath}.sha256 (${hash})`);
  return { checksum: `${exePath}.sha256`, manifest: manifestPath, sha256: hash };
}

async function cli(argv) {
  let options;
  try { options = parseArgs(argv); } catch (problem) { console.error(`${problem.message}\n${USAGE}`); return 2; }
  if (options.help) { console.log(USAGE); return 0; }
  try { await writeBuildSidecars(options); return 0; } catch (problem) { console.error(problem.message); return 1; }
}

if (require.main === module) cli(process.argv.slice(2)).then(code => { process.exitCode = code; });

module.exports = { parseArgs, writeBuildSidecars, SidecarError, USAGE };
