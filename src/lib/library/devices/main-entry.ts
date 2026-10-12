/**
 * Entry of the main-process bundle of the device catalogue (electron/library/devices-core.cjs, built by
 * scripts/library-devices-core.cjs). It exports only what the native side needs: the catalogue pipeline and the correction codec.
 */
export { ALL_STEPS, STEP_NAMES, buildDeviceCatalogue } from './catalogue';
export { createFileNameAnchorSource, deriveBoardAnchors } from './anchor-source';
export { CANONICAL_ROLE_OF, CORRECTIONS_VERSION, FILE_ROLES, MAX_CORRECTIONS, parseCorrections, serializeCorrections } from './corrections';
