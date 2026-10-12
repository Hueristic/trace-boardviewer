'use strict';

// The QA switch of the device database (LIB-02). The release switch (DEVICE_DATABASE_ENABLED in electron/main.cjs and
// src/lib/library/devices/feature.ts) stays false. Only a packaged QA build (extraMetadata.traceBuildFlavor "qa", see
// config/electron-builder.qa*.yml), started with TRACE_QA_DEVICE_DATABASE=1, turns the bridge on for the three-platform scenario
// (scripts/packaged-functional-library.cjs). Any other build, or any other value, keeps the feature off: the release can never be
// switched on from its environment.

const ENVIRONMENT_NAME = 'TRACE_QA_DEVICE_DATABASE';
// The renderer learns the switch as a launch argument of its own window, set by the main process only when the switch is on.
// electron/preload.cjs reads the same text (a sandboxed preload cannot require this module).
const RENDERER_ARGUMENT = '--trace-qa-device-database';

/** True only for a packaged QA build whose environment says so; a value other than exactly "1" is off. */
function deviceDatabaseQaSwitch({ isPackaged, buildFlavour, env }) {
  return isPackaged === true && buildFlavour === 'qa' && !!env && env[ENVIRONMENT_NAME] === '1';
}

module.exports = Object.freeze({ ENVIRONMENT_NAME, RENDERER_ARGUMENT, deviceDatabaseQaSwitch });
