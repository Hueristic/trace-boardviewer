import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { allegro } from '../../recognizers';
import { allegroHook, parseAllegro } from '../../allegro';
import { MAX_NATIVE_ALLEGRO_IMPORT_BYTES, MAX_NATIVE_ALLEGRO_RECORDS } from '../../common';
import { mebibytes } from '../../import-limits';

export default defineBoardAdapter({
  capability: {
    id: 'allegro-brd', name: 'Cadence Allegro BRD (native)', extensions: ['.brd'], variants: ['Documented 16.0–17.5 keyed binary layouts; legacy and newer layouts recognized but unsupported'], status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'mixed',
    units: 'header coordinate divisor × mil to mm', sides: 'placed footprint layer; drilled through pads on both sides',
    notes: ['Native 16.2 (including alternate identifier 0x00130500), 16.4, 16.5, 16.6 and 17.2 database layouts were validated with local files; 16.0, 17.4 and 17.5 use synthetic validation.', 'Explicit keyed records, string references, list cycles and declared object counts are validated before import. Unsupported versions or record types are refused.', 'Component bodies are estimated from pads. Curved outlines use chords and custom pad shapes use their declared rectangular extents. Tracks, copper fills, general graphics and vias are omitted.', `Native databases up to ${mebibytes(MAX_NATIVE_ALLEGRO_IMPORT_BYTES)} MiB and ${MAX_NATIVE_ALLEGRO_RECORDS / 1_000_000} million declared objects are read; larger ones are refused with a named, localized LIMIT_EXCEEDED message. Observed 14.x/15.x layouts are identified but refused; export GenCAD. Footprint layer codes other than 0/1 are unsupported.`],
  },
  listOrder: 160,
  family: 'ECAD design',
  detection: 'signature',
  sniff: ({ head }) => { const found = allegro(head); return found ? sniffed(100, `Allegro database magic (${found.detail}) and "all" at 0xF8`, { variant: found.detail, ...(found.detail ? { meta: { version: found.detail } } : {}) }) : NO_MATCH; },
  parse: parseAllegro,
  structure: allegroHook,
  // The native byte limit applies to this adapter only; every other adapter keeps DEFAULT_LIMITS (MAX_IMPORT_BYTES).
  limits: { maxInputBytes: MAX_NATIVE_ALLEGRO_IMPORT_BYTES, maxTotalBytes: MAX_NATIVE_ALLEGRO_IMPORT_BYTES },
});
