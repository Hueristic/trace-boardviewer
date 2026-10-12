'use strict';

// The macOS application menu as a template (main.cjs passes it to Menu.buildFromTemplate). A pure function, so the checks read the
// template for every language without Electron. macOS routes Cmd+Q, Cmd+H, Cmd+M, Cmd+W and the Edit key equivalents through this menu,
// and setApplicationMenu(null) leaves Electron's default menu in place there, View > Reload and Toggle Developer Tools included. So the
// menu is minimal: the application, Edit and Window menus with their standard roles only, no View and no Help (the role menus would add
// Services, Speech and the window list). The one custom item is Settings…, which asks the renderer to open its settings. Windows and
// Linux keep no menu bar, so there is no template for them (null).
// Every role item keeps its role, so the action and the accelerator stay native, and takes its label from the catalogue: without a label
// macOS shows the system's English text for the role. The application items name the application (the menu of the app name).
function applicationMenuTemplate({ platform, appName, t, openSettings }) {
  if (platform !== 'darwin') return null;
  const app = { app: appName };
  return [
    { label: appName, submenu: [
      { role: 'about', label: t('native.menu.about', app) }, { type: 'separator' },
      { label: t('native.menu.settings'), accelerator: 'Cmd+,', click: openSettings }, { type: 'separator' },
      { role: 'hide', label: t('native.menu.hide', app) }, { role: 'hideOthers', label: t('native.menu.hideOthers') }, { role: 'unhide', label: t('native.menu.unhide') }, { type: 'separator' },
      { role: 'quit', label: t('native.menu.quit', app) },
    ] },
    { label: t('native.menu.edit'), submenu: [
      { role: 'undo', label: t('native.menu.undo') }, { role: 'redo', label: t('native.menu.redo') }, { type: 'separator' },
      { role: 'cut', label: t('native.menu.cut') }, { role: 'copy', label: t('native.menu.copy') }, { role: 'paste', label: t('native.menu.paste') }, { role: 'selectAll', label: t('native.menu.selectAll') },
    ] },
    { label: t('native.menu.window'), submenu: [
      { role: 'minimize', label: t('native.menu.minimize') }, { role: 'zoom', label: t('native.menu.zoom') }, { role: 'close', label: t('native.menu.closeWindow') },
    ] },
  ];
}

module.exports = Object.freeze({ applicationMenuTemplate });
