/**
 * Release switch of the device database (Library). While false, the top bar shows no entry and the dialog cannot be opened.
 * The view, the port and the bridge stay in the build so that they can be tested; the switch changes only the entry point.
 * It goes to true when the folder tree, the board list, root persistence and scan cancel work end to end on all three platforms.
 */
export const DEVICE_DATABASE_ENABLED = false;

/**
 * Whether the device database entry is shown: the release switch above, or the QA switch the main process set for this window
 * (electron/device-switch.cjs, LIB-02). A release build never sets the QA switch, so this stays false there.
 */
export function deviceDatabaseVisible(qaSwitch: boolean | undefined): boolean {
  return DEVICE_DATABASE_ENABLED || qaSwitch === true;
}
