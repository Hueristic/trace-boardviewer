import { LIBRARY_STAGES, type LibraryStage } from '../../lib/library/model';
import { atomic, int, jsonIds, run, type Ctx } from './context';
import { getMeta, setMeta, stageVersionKey } from './meta';

/** Stages that consume the output of a stage: they run again when it does. Everything else keeps its result. */
export const STAGE_DEPENDANTS: Readonly<Record<LibraryStage, readonly LibraryStage[]>> = Object.freeze({
  enumerate: [],
  identity: [],
  sniff: ['summary', 'knowledge', 'group'],
  name: ['group'],
  summary: ['knowledge', 'group', 'full-text'],
  knowledge: ['group'],
  ocr: ['knowledge', 'group'],
  group: [],
  'full-text': [],
});

/** The version the index was last brought to for a stage; 0 when the stage never ran. */
export function stageVersion(ctx: Ctx, stage: LibraryStage): number {
  const n = Number(getMeta(ctx, stageVersionKey(stage)) ?? 0);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

export interface StageBump { stage: LibraryStage; from: number; to: number; invalidated: number }

/**
 * Records a new version of a stage's implementation (an extractor, the knowledge tables, the sniffers, the grouping rules). Contents whose
 * stage row is older are offered again by `listPending`; the stages that depend on it are marked pending where they had finished, so a
 * change reruns that stage and its dependants only. Lowering a version is refused.
 */
export function bumpStageVersion(ctx: Ctx, stage: LibraryStage, version: number): StageBump | undefined {
  if (!(LIBRARY_STAGES as readonly string[]).includes(stage) || !Number.isSafeInteger(version) || version < 0) return undefined;
  const from = stageVersion(ctx, stage);
  if (version < from) return undefined;
  const dependants = STAGE_DEPENDANTS[stage];
  const invalidated = version === from ? 0 : atomic(ctx, () => {
    setMeta(ctx, stageVersionKey(stage), String(version));
    if (dependants.length === 0) return 0;
    return run(ctx, "UPDATE stage SET state = 'pending' WHERE stage IN (SELECT value FROM json_each(?)) AND state = 'done'", jsonIds([...dependants])).changes;
  });
  if (version === from && getMeta(ctx, stageVersionKey(stage)) === undefined) atomic(ctx, () => setMeta(ctx, stageVersionKey(stage), String(version)));
  return { stage, from, to: version, invalidated: int(invalidated) };
}
