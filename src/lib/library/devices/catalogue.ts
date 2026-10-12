/**
 * The device catalogue pipeline: folder map, name identity, BIOS candidates, matching and corrections, each step skippable.
 *
 * Read-only by construction: the only file-system access is `DirectoryPort.readDir`. Nothing is copied, renamed, moved, deleted
 * or opened; the output is an index view that the caller stores in the Library database.
 */
import { CANCELLED_CODE, DEFAULT_LIMITS, mapFolderTree, type DirectoryPort, type FileNode, type FolderMap, type FolderNode, type MapLimits } from './folder-map';
import { applyCorrections, compactCorrections, fileRefOf, patchAnchors, type Correction } from './corrections';
import { extractIdentity, type FileIdentity, type FileRole } from './identity';
import { matchFiles, type Association, type BoardAnchor, type FileRecord, type MatchCounters } from './match';
import { canonicalPath, collidingKeys, spellingKey, type DevicePlatform } from './paths';
import { deriveBoardAnchors, type BoardAnchorSource } from './anchor-source';

export { deriveBoardAnchors } from './anchor-source';

export const STEP_NAMES = ['folderMap', 'nameIdentity', 'biosCandidates', 'matching', 'corrections'] as const;
export type StepName = (typeof STEP_NAMES)[number];
export type StepSwitches = Record<StepName, boolean>;
export const ALL_STEPS: Readonly<StepSwitches> = { folderMap: true, nameIdentity: true, biosCandidates: true, matching: true, corrections: true };

/** Roles that come from firmware extensions or their name tokens. They are candidates only, never BIOS by default. */
const FIRMWARE_ROLES: ReadonlySet<FileRole> = new Set<FileRole>(['bios-candidate', 'ec-firmware', 'me-firmware', 'saved-dump']);

export interface RootInput {
  rootId: string;
  port: DirectoryPort;
  limits?: MapLimits;
  /** Canonical paths of folders the user excluded; their subtree is not read. */
  skipPaths?: ReadonlySet<string>;
}

export interface CatalogueInput {
  platform: DevicePlatform;
  roots: readonly RootInput[];
  anchors: readonly BoardAnchor[];
  /** Unique strong content codes, keyed by file reference (`fileRefOf`). Absent for most files. */
  contentCodes?: ReadonlyMap<string, { code: string; unique: boolean }>;
  corrections?: readonly Correction[];
  steps?: Partial<StepSwitches>;
  /** Cancel signal, checked before each step and at every folder of the walk. A cancelled run throws and returns nothing. */
  signal?: AbortSignal;
  /** Derive board anchors from the scanned boardview files (board code and revision), so that their ids are stable across scans. */
  deriveAnchors?: boolean;
  /** Where the board anchors come from (see anchor-source.ts). Used when given, with or without deriveAnchors. */
  anchorSource?: BoardAnchorSource;
  /** Asked while the run goes: true for a step that has not started yet. That step is switched off, reported skipped, and the result is incomplete. */
  isStepSkipped?: (step: StepName) => boolean;
}

export interface IndexedFile {
  fileRef: string;
  rootId: string;
  path: string;
  size: number;
  identity: FileIdentity;
  /** Set only when this file shares its identity key with another file of the same root. Such a file is listed, never matched. */
  collision?: true;
}

/** Two or more files of one root whose names share an identity key. The paths are sorted. */
export interface Collision { rootId: string; paths: string[] }

/**
 * A file correction on darwin whose exact target is missing, while present files match it only by letter case or Unicode
 * normalisation (a case-insensitive or normalisation-insensitive APFS volume). Nothing is redirected: the correction has no effect
 * until the user confirms one of `candidatePaths`, which are the canonical paths of the present files, sorted.
 */
export interface NeedsManual { state: 'case-collision'; correction: Correction; candidatePaths: string[] }

/** Operation counts of one run, so that the cost can be checked without timing it. Summed over all roots. */
export interface CatalogueStats {
  folders: number;
  files: number;
  /** Listed entries: files, folders and skipped entries. */
  entries: number;
  match: MatchCounters;
}

export interface CatalogueResult {
  steps: Record<StepName, 'ran' | 'skipped'>;
  maps: Array<{ rootId: string; map: FolderMap | null }>;
  files: IndexedFile[];
  associations: Association[];
  /** Corrections whose target file is not in the scan, or whose target is a collision. Kept for review; never redirected. */
  missingTargets: Correction[];
  /** darwin only: targets that match a present file by letter case or normalisation alone. They need a manual confirmation. */
  needsManual: NeedsManual[];
  /** Firmware candidates left out because biosCandidates is off. */
  excludedFirmwareCount: number;
  collisions: Collision[];
  stats: CatalogueStats;
  /** The anchors matching used: the input anchors plus derived ones, patched by corrections. */
  anchors: BoardAnchor[];
  /** True only when every step ran and every root's map is complete. A partial result is never reported as complete. */
  complete: boolean;
  /** The steps that were switched off by isStepSkipped during the run (not by the steps switches). */
  skippedByRequest: StepName[];
}

/**
 * Splits the missing file targets of darwin into case-collisions and plain missing targets. A target is a case-collision when a
 * present file of the same root has the same spelling key (NFC, lower case) and a different exact path. Other platforms and all
 * other corrections are returned unchanged in `missing`. Linear in the files plus the corrections.
 */
function classifyMissingTargets(
  missing: readonly Correction[],
  present: ReadonlyArray<{ rootId: string; path: string }>,
  platform: DevicePlatform,
): { missing: Correction[]; needsManual: NeedsManual[] } {
  if (platform !== 'darwin' || missing.length === 0) return { missing: [...missing], needsManual: [] };
  const index = new Map<string, Set<string>>();
  for (const file of present) {
    const key = `${file.rootId}\u0000${spellingKey(file.path)}`;
    const paths = index.get(key) ?? new Set<string>();
    paths.add(file.path);
    index.set(key, paths);
  }
  const rest: Correction[] = [];
  const needsManual: NeedsManual[] = [];
  for (const correction of missing) {
    if (!('file' in correction)) {
      rest.push(correction);
      continue;
    }
    const wanted = canonicalPath(correction.file.path.split('/').filter(part => part !== ''));
    const candidates = index.get(`${correction.file.rootId}\u0000${spellingKey(wanted)}`);
    const candidatePaths = candidates === undefined ? [] : [...candidates].filter(path => path !== wanted).sort();
    if (candidatePaths.length > 0) needsManual.push({ state: 'case-collision', correction, candidatePaths });
    else rest.push(correction);
  }
  return { missing: rest, needsManual };
}

function* walkFiles(folder: FolderNode): Generator<FileNode> {
  const stack: FolderNode[] = [folder];
  while (stack.length > 0) {
    const node = stack.pop()!;
    yield* node.files;
    // A loop, not push(...spread): a folder with very many sub-folders overflows the call stack when spread.
    for (const child of node.folders) stack.push(child);
  }
}

/** The input anchors first; a derived anchor is added only when no input anchor has the same id. */
function mergeAnchors(input: readonly BoardAnchor[], derived: readonly BoardAnchor[]): BoardAnchor[] {
  const ids = new Set(input.map(anchor => anchor.id));
  return [...input, ...derived.filter(anchor => !ids.has(anchor.id))];
}

export async function buildDeviceCatalogue(input: CatalogueInput): Promise<CatalogueResult> {
  const on: Record<StepName, boolean> = { ...ALL_STEPS, ...(input.steps ?? {}) };
  const steps: Record<StepName, 'ran' | 'skipped'> = { folderMap: 'skipped', nameIdentity: 'skipped', biosCandidates: 'skipped', matching: 'skipped', corrections: 'skipped' };
  const skippedByRequest: StepName[] = [];
  // Checked before a step starts. A step switched off this way is never started, so its output stays empty and the result is incomplete.
  const skipRequested = (step: StepName): void => {
    if (on[step] && input.isStepSkipped?.(step) === true) {
      on[step] = false;
      skippedByRequest.push(step);
    }
  };
  const maps: CatalogueResult['maps'] = input.roots.map(root => ({ rootId: root.rootId, map: null }));
  const files: IndexedFile[] = [];
  let excludedFirmwareCount = 0;
  let anchors: BoardAnchor[] = [...input.anchors];
  let associations: Association[] = [];
  let missingTargets: Correction[] = [];
  let needsManual: NeedsManual[] = [];
  const collisions: Collision[] = [];
  const matchCounters: MatchCounters = { files: 0, candidates: 0, judgments: 0, linkSteps: 0 };

  // Checked before every step and every few thousand files: a cancel never waits for a later step to finish.
  const throwIfCancelled = (): void => {
    if (input.signal?.aborted) throw Object.assign(new Error('the scan was cancelled'), { name: 'AbortError', code: CANCELLED_CODE });
  };
  skipRequested('folderMap');
  if (on.folderMap) {
    steps.folderMap = 'ran';
    for (let index = 0; index < input.roots.length; index++) {
      const root = input.roots[index];
      throwIfCancelled();
      maps[index].map = await mapFolderTree(root.port, input.platform, root.limits ?? DEFAULT_LIMITS, { signal: input.signal, skipPaths: root.skipPaths });
    }
  }

  skipRequested('corrections');
  throwIfCancelled();
  const corrections = on.corrections ? compactCorrections(input.corrections ?? [], input.platform) : [];
  const pending: Array<{ rootId: string; file: FileNode; fileRef: string }> = [];
  skipRequested('nameIdentity');
  skipRequested('biosCandidates');
  if (on.folderMap && on.nameIdentity) {
    for (const entry of maps) {
      if (entry.map === null) continue;
      for (const file of walkFiles(entry.map.root)) {
        pending.push({ rootId: entry.rootId, file, fileRef: fileRefOf({ rootId: entry.rootId, path: file.path }, input.platform) });
      }
    }
  }
  // Files whose identity keys collide are not present for matching or corrections: a correction must not reach either of them.
  const colliding = collidingKeys(pending.map(item => ({ key: item.fileRef, path: item.file.path })));
  const presentRefs = new Set<string>();
  for (const item of pending) if (!colliding.has(item.fileRef)) presentRefs.add(item.fileRef);
  if (colliding.size > 0) {
    const groups = new Map<string, { rootId: string; paths: Set<string> }>();
    for (const item of pending) {
      if (!colliding.has(item.fileRef)) continue;
      const group = groups.get(item.fileRef) ?? { rootId: item.rootId, paths: new Set<string>() };
      group.paths.add(item.file.path);
      groups.set(item.fileRef, group);
    }
    for (const group of groups.values()) collisions.push({ rootId: group.rootId, paths: [...group.paths].sort() });
    collisions.sort((a, b) => (a.rootId !== b.rootId ? (a.rootId < b.rootId ? -1 : 1) : a.paths[0] < b.paths[0] ? -1 : a.paths[0] > b.paths[0] ? 1 : 0));
  }

  const applied = on.corrections ? applyCorrections(input.corrections ?? [], input.platform, presentRefs) : undefined;
  if (applied !== undefined) {
    // The anchor patches are applied after the anchors are derived or sourced (below), so they are not applied here.
    const present = pending.filter(item => presentRefs.has(item.fileRef)).map(item => ({ rootId: item.rootId, path: item.file.path }));
    const split = classifyMissingTargets(applied.missingTargets, present, input.platform);
    missingTargets = split.missing;
    needsManual = split.needsManual;
    steps.corrections = 'ran';
  }

  throwIfCancelled();
  if (on.folderMap && on.nameIdentity) {
    steps.nameIdentity = 'ran';
    let processed = 0;
    for (const { rootId, file, fileRef } of pending) {
      if (++processed % 4096 === 0) throwIfCancelled();
      const overrideRole = applied?.roleOverrides.get(fileRef);
      const identity = extractIdentity(file.path, { platform: input.platform, roleOverride: overrideRole ?? undefined });
      if (!on.biosCandidates && FIRMWARE_ROLES.has(identity.role)) {
        excludedFirmwareCount++;
        continue;
      }
      const indexed: IndexedFile = { fileRef, rootId, path: file.path, size: file.size, identity };
      if (colliding.has(fileRef)) indexed.collision = true;
      files.push(indexed);
    }
    if (on.biosCandidates) steps.biosCandidates = 'ran';
  }

  throwIfCancelled();
  if (steps.nameIdentity === 'ran' && (input.deriveAnchors === true || input.anchorSource !== undefined)) {
    const derived = deriveBoardAnchors(files);
    const sourced = input.anchorSource === undefined ? derived : await input.anchorSource.anchorsFor({ files, derived });
    anchors = mergeAnchors(input.anchors, sourced);
  }
  if (applied !== undefined) anchors = patchAnchors(anchors, applied.anchorPatches);
  skipRequested('matching');
  if (on.matching && steps.nameIdentity === 'ran') {
    steps.matching = 'ran';
    const records: FileRecord[] = [];
    for (const file of files) {
      if (file.collision === true) continue;
      const content = input.contentCodes?.get(file.fileRef);
      records.push(content === undefined ? { path: file.fileRef, identity: file.identity } : { path: file.fileRef, identity: file.identity, contentCode: content });
    }
    associations = matchFiles(anchors, records, applied?.decisions ?? {}, matchCounters);
  }

  const stats: CatalogueStats = { folders: 0, files: 0, entries: 0, match: matchCounters };
  for (const entry of maps) {
    if (entry.map === null) continue;
    stats.folders += entry.map.folderCount;
    stats.files += entry.map.fileCount;
    stats.entries += entry.map.fileCount + entry.map.folderCount + entry.map.skippedCount;
  }
  const complete = (Object.values(steps) as string[]).every(state => state === 'ran') && maps.every(entry => entry.map === null || entry.map.complete);
  return { steps, maps, files, associations, missingTargets, needsManual, excludedFirmwareCount, collisions, stats, anchors, complete, skippedByRequest };
}
