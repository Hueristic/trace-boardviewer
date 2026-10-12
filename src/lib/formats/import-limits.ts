import { BoardFormatError, localizedFormatError, MAX_IMPORT_BYTES, MAX_NATIVE_ALLEGRO_IMPORT_BYTES } from './common';
import { allegro } from './recognizers';

/**
 * The import byte limit for one input. A native Allegro BRD database (recognized by its header, not its name) may be larger than
 * the general limit, because the native limit was measured for it (docs/ALLEGRO-BRD.md); every other input keeps MAX_IMPORT_BYTES.
 */
export function importLimitFor(data: Uint8Array): number {
  return allegro(data) ? MAX_NATIVE_ALLEGRO_IMPORT_BYTES : MAX_IMPORT_BYTES;
}

/** A byte limit as whole mebibytes, for messages (the limits are multiples of one mebibyte). */
export const mebibytes = (bytes: number): number => Math.round(bytes / 1048576);

/** The refusal of a native database above the native byte limit: a named LIMIT_EXCEEDED error with a localized text (catalog key). */
export function nativeByteLimitError(limit: number): BoardFormatError {
  const max = mebibytes(limit);
  return localizedFormatError(`Allegro: database exceeds the ${max} MiB import limit.`, 'LIMIT_EXCEEDED', { key: 'parse.error.nativeByteLimit', params: { max } }, 'allegro-brd');
}

/** The refusal of a native database above the record budget: a named LIMIT_EXCEEDED error with a localized text (catalog key). */
export function nativeRecordLimitError(max: number): BoardFormatError {
  return localizedFormatError(`Allegro: database declares more than ${max} objects, the native record limit.`, 'LIMIT_EXCEEDED', { key: 'parse.error.nativeRecordLimit', params: { max } }, 'allegro-brd');
}
