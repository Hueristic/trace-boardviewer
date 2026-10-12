#!/usr/bin/env node
'use strict';

// Windows provenance record for the portable EXE (TB-105, TB-106). It is the Windows counterpart of the Mac record written by
// scripts/mac-payload-manifest.cjs (MAC-PIPE-4): it binds the EXE and its app.asar, by SHA-256, to the source commit, to the build
// configuration file and to the electron-builder version that built them. The record has no timestamps and no paths, so the same
// inputs always give the same bytes.
//
// Usage:  node scripts/win-provenance.cjs --exe <TRACE-Boardviewer-x.exe> --asar <app.asar> --commit <40-hex sha>
//                 --config <build config file> --electron-builder-version <version> --out <record.json>
// Output: { schema: 'trace-win-provenance/1', commit, package: { name, sha256, size }, asar: { sha256, size },
//           buildConfig: { name, sha256 }, electronBuilder: { version } }
// Exit codes: 0 record written; 1 a named file is missing or unreadable (nothing is written); 2 usage error.

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const SCHEMA = 'trace-win-provenance/1';
const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;
const REQUIRED = ['--exe', '--asar', '--commit', '--config', '--electron-builder-version', '--out'];
const EXIT = Object.freeze({ OK: 0, FAIL: 1, USAGE: 2 });
const USAGE = 'Usage: node scripts/win-provenance.cjs --exe <exe> --asar <app.asar> --commit <40-hex sha> --config <build config>'
  + ' --electron-builder-version <version> --out <record.json>';

class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; }
}
class ProvenanceError extends Error {
  constructor(message) { super(message); this.name = 'ProvenanceError'; }
}

/** The options, or a UsageError. Each flag takes one value, as "--flag value" or "--flag=value", and may appear once. */
function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    if (!REQUIRED.includes(flag)) throw new UsageError(`Unknown argument: ${arg}`);
    if (values.has(flag)) throw new UsageError(`Duplicate argument: ${flag}`);
    if (equals > 0) {
      values.set(flag, arg.slice(equals + 1));
    } else {
      if (index + 1 >= argv.length) throw new UsageError(`${flag} needs a value.`);
      values.set(flag, argv[++index]);
    }
  }
  for (const flag of REQUIRED) if (!values.has(flag)) throw new UsageError(`${flag} is required.`);
  const commit = values.get('--commit');
  const electronBuilderVersion = values.get('--electron-builder-version');
  if (!COMMIT_RE.test(commit)) throw new UsageError('--commit must be a full 40-character lowercase commit id.');
  if (!VERSION_RE.test(electronBuilderVersion)) throw new UsageError('--electron-builder-version must be a version such as 26.15.3.');
  return {
    exe: path.resolve(values.get('--exe')),
    asar: path.resolve(values.get('--asar')),
    config: path.resolve(values.get('--config')),
    out: path.resolve(values.get('--out')),
    commit,
    electronBuilderVersion,
  };
}

/** The SHA-256 (streamed, never a whole-file buffer) and size of one file, with its base name. */
function fileRecord(file) {
  return new Promise((resolve, reject) => {
    fs.stat(file, (statError, stat) => {
      if (statError) return reject(new ProvenanceError(`cannot read ${file}: ${statError.code || statError.message}`));
      if (!stat.isFile()) return reject(new ProvenanceError(`not a file: ${file}`));
      const hash = createHash('sha256');
      const stream = fs.createReadStream(file);
      stream.on('error', (error) => reject(new ProvenanceError(`cannot read ${file}: ${error.code || error.message}`)));
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve({ name: path.basename(file), sha256: hash.digest('hex'), size: stat.size }));
    });
  });
}

/** The record for the given file records. Pure: no I/O, no timestamps. */
function buildWinProvenance({ exe, asar, config, commit, electronBuilderVersion }) {
  return {
    schema: SCHEMA,
    commit,
    package: { name: exe.name, sha256: exe.sha256, size: exe.size },
    asar: { sha256: asar.sha256, size: asar.size },
    buildConfig: { name: config.name, sha256: config.sha256 },
    electronBuilder: { version: electronBuilderVersion },
  };
}

/**
 * Everything wrong with a record, given the values it must match. `expected` takes commit, packageSha256, asarSha256 and, when
 * given, buildConfigSha256 and electronBuilderVersion. Returns the problems; never throws.
 */
function checkWinProvenance(record, expected) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return ['the provenance record is not a JSON object'];
  const problems = [];
  if (record.schema !== SCHEMA) problems.push(`schema is ${JSON.stringify(record.schema)}, expected "${SCHEMA}"`);
  if (record.commit !== expected.commit) problems.push(`commit ${JSON.stringify(record.commit)} is not the expected commit ${expected.commit}`);
  if (!SHA256_RE.test(record.package?.sha256 ?? '')) problems.push('package sha256 is missing or not a SHA-256');
  else if (record.package.sha256 !== expected.packageSha256) problems.push('package sha256 differs from the EXE');
  if (!SHA256_RE.test(record.asar?.sha256 ?? '')) problems.push('asar sha256 is missing or not a SHA-256');
  else if (record.asar.sha256 !== expected.asarSha256) problems.push('asar sha256 differs from app.asar');
  if (expected.buildConfigSha256 !== undefined && record.buildConfig?.sha256 !== expected.buildConfigSha256) {
    problems.push('build configuration sha256 differs from the config file');
  }
  if (expected.electronBuilderVersion !== undefined && record.electronBuilder?.version !== expected.electronBuilderVersion) {
    problems.push(`electron-builder version ${JSON.stringify(record.electronBuilder?.version)} is not ${expected.electronBuilderVersion}`);
  }
  return problems;
}

/** Hashes the three files and writes the record; nothing is written when a file is missing. */
async function writeWinProvenance(options) {
  const [exe, asar, config] = await Promise.all([fileRecord(options.exe), fileRecord(options.asar), fileRecord(options.config)]);
  const record = buildWinProvenance({ exe, asar, config, commit: options.commit, electronBuilderVersion: options.electronBuilderVersion });
  await fsp.mkdir(path.dirname(options.out), { recursive: true });
  await fsp.writeFile(options.out, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

async function cli(argv) {
  let options;
  try { options = parseArgs(argv); } catch (problem) {
    console.error(`${problem.message}\n${USAGE}`);
    return EXIT.USAGE;
  }
  try {
    const record = await writeWinProvenance(options);
    console.log(`win provenance: commit ${record.commit}, package ${record.package.name} sha256 ${record.package.sha256}`);
    console.log(`  app.asar sha256 ${record.asar.sha256}, electron-builder ${record.electronBuilder.version}`);
    console.log(`  written to ${options.out}`);
    return EXIT.OK;
  } catch (problem) {
    console.error(`Win provenance failed: ${problem.message}`);
    return EXIT.FAIL;
  }
}

if (require.main === module) cli(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = { SCHEMA, EXIT, USAGE, UsageError, ProvenanceError, parseArgs, fileRecord, buildWinProvenance, checkWinProvenance, writeWinProvenance };
