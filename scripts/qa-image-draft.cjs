'use strict';

// Real-component regression for unsaved note drafts, in every interface language. Drives the workspace harness (harness/workspace.html: the
// real Shell on the synthetic mock core in src/app/mock-api.ts) through document and tab switches, Escape/Cancel, saving, removal and reload.
// The language is chosen through the stored settings (localStorage "trace-settings"), and every expected message is read from that language's
// catalog. Every request except the local dev server is aborted, and no file outside TRACE_QA_OUT is written. Exit code 1 on any failure.
//   node node_modules/vite/bin/vite.js --port 5211 --strictPort            (in another shell, fresh)
//   TRACE_QA_URL=http://127.0.0.1:5211 TRACE_QA_OUT=<private folder> [TRACE_QA_LANGS=hu,en,...] node scripts/qa-image-draft.cjs
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const { chromium } = require(process.env.TRACE_PLAYWRIGHT_PATH || path.join(ROOT, 'node_modules', 'playwright'));
const BASE = process.env.TRACE_QA_URL || 'http://127.0.0.1:5211';
const OUT = process.env.TRACE_QA_OUT || path.join(ROOT, 'test-results', 'image-draft-qa');
const LANGS = (process.env.TRACE_QA_LANGS || 'hu,en,de,fr,it,sk,pl,uk').split(',').map(s => s.trim()).filter(Boolean);
const KEYS = ['notes.draftBlocked', 'notes.draftKept', 'notes.draftMoved', 'notes.draftRestored'];
fs.mkdirSync(OUT, { recursive: true });

// The expected texts come from the shipped catalogs, one set per language.
const readCatalog = (lang, namespace) => JSON.parse(fs.readFileSync(path.join(ROOT, 'electron', 'locales', lang, `${namespace}.json`), 'utf8'));
const catalogFor = lang => ({ ...readCatalog(lang, 'common'), ...readCatalog(lang, 'notes') });
const TEXTS = Object.fromEntries(LANGS.map(lang => {
  const c = catalogFor(lang);
  return [lang, {
    blocked: c['notes.draftBlocked'], kept: c['notes.draftKept'], moved: c['notes.draftMoved'], restored: c['notes.draftRestored'],
    addNote: c['notes.addNote'], note: c['common.note'], save: c['common.save'], saveHint: c['notes.saveWithShortcut'], saveHintApple: c['images.saveWithCmd'], cancel: c['common.cancel'], del: c['common.delete'], newNote: c['notes.newNote'], editNote: c['notes.editNote'], panelLabel: c['notes.bookmarksAndNotes'],
  }];
}));

const results = [];
const check = async (name, page, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    const shot = path.join(OUT, `fail-${results.length + 1}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    results.push({ name, ok: false, error: String(error.message).slice(0, 500), screenshot: shot });
    console.log(`FAIL ${name}\n  ${String(error.message).slice(0, 500)}\n  screenshot: ${shot}`);
  }
};

// A shown message must be the catalog text: no placeholder left unfilled, and never the raw key.
const assertMessage = (shown, expected, label) => {
  assert.equal(shown, expected, `${label}: not the catalog text`);
  assert.ok(!/[{}]/.test(shown), `${label}: a placeholder was left in the text`);
  assert.ok(!shown.includes('notes.draft'), `${label}: the raw key is shown`);
};

async function main() {
  const browser = await chromium.launch({ args: ['--force-color-profile=srgb'] });
  const problems = [];

  const open = async (lang, { width = 1440, height = 940, query = '' } = {}) => {
    const context = await browser.newContext({ viewport: { width, height }, acceptDownloads: false });
    // The language is the stored one: a saved language wins over the system language (src/components/workspace/settings.ts).
    await context.addInitScript(l => { try { localStorage.setItem('trace-settings', JSON.stringify({ language: l })); } catch { /* storage unavailable */ } }, lang);
    const page = await context.newPage();
    page.on('pageerror', error => problems.push(`[${lang}] pageerror: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') problems.push(`[${lang}] console error: ${message.text().slice(0, 200)}`); });
    await page.route('**/*', route => (route.request().url().startsWith(BASE) ? route.continue() : route.abort()));
    await page.goto(`${BASE}/harness/workspace.html?persistence=session-only&motion=off${query}`);
    await page.waitForFunction(() => window.__mock !== undefined);
    await page.waitForSelector('[data-testid=tab-documents]');
    await page.waitForTimeout(800);
    if (await page.locator('[data-testid=support-not-now]').count()) await page.click('[data-testid=support-not-now]');
    return { context, page };
  };

  const runLanguage = async lang => {
    const TEXT = TEXTS[lang];
    const tag = name => `[${lang}] ${name}`;
    const { context, page } = await open(lang);

    // ---- helpers over the real UI -----------------------------------------------------------------------------------
    const openRow = async name => {
      await page.click('[data-testid=tab-documents]');
      await page.locator('.wsp-doc-main', { hasText: name }).first().click();
      await page.waitForFunction(() => document.querySelector('[data-testid=document-viewer]')?.getAttribute('data-kind') && document.querySelector('.imgv canvas') !== null || document.querySelector('[data-testid=document-viewer][data-kind=pdf]') !== null, null, { timeout: 15000 });
    };
    const canvas = () => page.locator('.imgv canvas').first();
    // Places a new note near (fx, fy) of the canvas. A click on an existing marker opens that note instead, so the helper steps to
    // nearby spots until the editor it opens is a "New note" (an edit it opened is closed again first: it is clean).
    const placeNoteAt = async (fx, fy) => {
      await page.locator(`.imgv button[aria-label=${JSON.stringify(TEXT.addNote)}]`).first().click(); // the note tool, as a user picks it
      const box = await canvas().boundingBox();
      const spots = [[fx, fy], [fx + 0.12, fy], [fx, fy + 0.1], [fx - 0.12, fy - 0.1], [fx + 0.12, fy + 0.1]];
      for (const [x, y] of spots) {
        await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
        await page.waitForSelector('.imgv-editor');
        if ((await page.locator('.imgv-editor button').count()) === 2) return; // a new note has Cancel and Save only; an edit also has Delete (no label is read here)
        await page.press('.imgv-editor textarea', 'Escape');
      }
      throw new Error('no empty spot for a new note near the requested point');
    };
    const editorValue = () => page.locator('.imgv-editor textarea').inputValue();
    const editorOpen = async () => (await page.locator('.imgv-editor').count()) > 0;
    const alertText = () => page.locator('.imgv-editor [role=alert]').first().textContent().catch(() => null);
    const savedTexts = id => page.evaluate(docId => (window.__mock.state().documents.find(d => d.record.id === docId)?.record.annotations ?? []).map(a => a.text), id);
    const clickEditorButton = label => page.locator('.imgv-editor button', { hasText: label }).first().click();
    const addImageDocument = (id, name) => page.evaluate(async ([docId, docName]) => {
      const c = Object.assign(document.createElement('canvas'), { width: 320, height: 200 });
      const x = c.getContext('2d'); x.fillStyle = '#345a7a'; x.fillRect(0, 0, 320, 200);
      const blob = await new Promise(resolve => c.toBlob(resolve, 'image/png'));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const img1 = window.__mock.state().documents.find(d => d.record.id === 'img1');
      const doc = { record: { ...img1.record, id: docId, name: docName, annotations: [], bookmarks: [] }, status: 'ready', bytes };
      window.__mock.hooks.patch({ documents: [...window.__mock.state().documents, doc] });
    }, [id, name]);

    // ---- scenarios --------------------------------------------------------------------------------------------------
    await check(tag('viewer labels are the catalog texts (note tool, Save, Cancel)'), page, async () => {
      await openRow('board-photo.png');
      const tool = page.locator(`.imgv button[aria-label=${JSON.stringify(TEXT.addNote)}]`);
      assert.equal(await tool.count(), 1, 'the note tool is not labelled with its catalog text');
      assert.equal((await tool.locator('.imgv-btn__label').textContent()).trim(), TEXT.note, 'the note tool label is not the catalog text');
      await placeNoteAt(0.3, 0.3);
      // The three labels this change localizes: the new-note dialog (accessible name and visible title), and the notes-panel toggle.
      assert.equal(await page.locator('.imgv-editor').getAttribute('aria-label'), TEXT.newNote, 'the new-note dialog label is not the catalog text');
      assert.equal((await page.locator('.imgv-editor__title').textContent()).trim(), TEXT.newNote, 'the new-note title is not the catalog text');
      assert.equal(await page.locator(`.imgv button[aria-label=${JSON.stringify(TEXT.panelLabel)}]`).count(), 1, 'the notes-panel toggle is not labelled with its catalog text');
      const save = page.locator('.imgv-editor button', { hasText: TEXT.save }).first();
      assert.equal((await save.textContent()).trim(), TEXT.save, 'the Save label is not the catalog text');
      // The Save hint names the platform's modifier as the app does (isApplePlatform): Cmd+Enter on Apple platforms, Ctrl+Enter elsewhere.
      const apple = await page.evaluate(() => /^(?:mac|iphone|ipad|ipod)/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ''));
      assert.equal(await save.getAttribute('title'), apple ? TEXT.saveHintApple : TEXT.saveHint, 'the Save hint is not the catalog text');
      assert.equal((await page.locator('.imgv-editor button', { hasText: TEXT.cancel }).first().textContent()).trim(), TEXT.cancel, 'the Cancel label is not the catalog text');
      await page.press('.imgv-editor textarea', 'Escape'); // a clean new note closes without saving anything
      assert.equal(await editorOpen(), false, 'the empty editor did not close');
      assert.deepEqual(await savedTexts('img1'), [], 'a note was saved by the label check');
    });

    await check(tag('typed draft survives a canvas-target change (blocked, not replaced)'), page, async () => {
      await openRow('board-photo.png');
      await placeNoteAt(0.3, 0.3);
      await page.fill('.imgv-editor textarea', 'alpha draft');
      await placeNoteAt(0.7, 0.6);
      assert.equal(await editorValue(), 'alpha draft', 'the draft text was replaced by another target');
      assertMessage(await alertText(), TEXT.blocked, `[${lang}] blocked message`);
      assert.deepEqual(await savedTexts('img1'), [], 'a second note was created by the blocked click');
      await clickEditorButton(TEXT.save);
      assert.deepEqual(await savedTexts('img1'), ['alpha draft'], 'saving the draft did not store it');
    });

    await check(tag('a draft is blocked by the notes-panel row of another note too'), page, async () => {
      await placeNoteAt(0.45, 0.4);
      await page.fill('.imgv-editor textarea', 'beta draft');
      if (!(await page.locator('.imgv-row__main[title="alpha draft"]').count())) await page.click(`.imgv button[aria-label=${JSON.stringify(TEXT.panelLabel)}]`);
      await page.locator('.imgv-row__main[title="alpha draft"]').first().click();
      assert.equal(await editorValue(), 'beta draft', 'opening another note from the panel replaced the draft');
      assertMessage(await alertText(), TEXT.blocked, `[${lang}] panel block message`);
    });

    await check(tag('Escape and Cancel keep an unsaved draft; clearing the text closes the editor'), page, async () => {
      await page.press('.imgv-editor textarea', 'Escape');
      assert.equal(await editorOpen(), true, 'Escape closed an editor with an unsaved draft');
      assertMessage(await alertText(), TEXT.kept, `[${lang}] Escape message`);
      // The notes panel opened earlier overlays the editor; close it so Cancel is reachable.
      if (await page.locator('.imgv-row__main[title="alpha draft"]').isVisible()) await page.click(`.imgv button[aria-label=${JSON.stringify(TEXT.panelLabel)}]`);
      // Typing clears the message, so the Cancel click must be the thing that brings it back.
      await page.fill('.imgv-editor textarea', 'beta draft!');
      await page.fill('.imgv-editor textarea', 'beta draft');
      assert.equal(await alertText(), null, 'the message did not clear while typing');
      await clickEditorButton(TEXT.cancel);
      assert.equal(await editorOpen(), true, 'Cancel closed an editor with an unsaved draft');
      assertMessage(await alertText(), TEXT.kept, `[${lang}] Cancel message`);
      assert.equal(await editorValue(), 'beta draft', 'Cancel altered the draft text');
      await page.fill('.imgv-editor textarea', '');
      await page.press('.imgv-editor textarea', 'Escape');
      assert.equal(await editorOpen(), false, 'a cleared draft did not close on Escape');
      assert.equal((await savedTexts('img1')).length, 1, 'Escape or Cancel created or changed a note');
    });

    await check(tag('a tab switch unmounts the viewer and the returning view restores the draft'), page, async () => {
      await placeNoteAt(0.5, 0.5);
      await page.fill('.imgv-editor textarea', 'gamma draft');
      await page.click('[data-testid=tab-board]');
      await page.waitForTimeout(400);
      await openRow('board-photo.png');
      await page.waitForSelector('.imgv-editor');
      assert.equal(await editorValue(), 'gamma draft', 'the draft did not come back after the tab switch');
      assertMessage(await page.getByText(TEXT.restored, { exact: true }).first().textContent().catch(() => null), TEXT.restored, `[${lang}] restored notice`);
    });

    await check(tag('a document switch never moves the draft to another document'), page, async () => {
      await page.locator('.wsp-doc-main', { hasText: 'service-manual.pdf' }).first().click();
      await page.waitForSelector('[data-testid=document-viewer][data-kind=pdf]');
      assert.equal(await editorOpen(), false, 'the PDF shows an editor of the image');
      await addImageDocument('img2', 'second-board.png');
      await page.waitForSelector('.wsp-doc-main:has-text("second-board.png")');
      await page.locator('.wsp-doc-main', { hasText: 'second-board.png' }).first().click();
      await page.waitForFunction(() => document.querySelector('[data-testid=document-viewer]')?.getAttribute('data-kind') === 'image' && document.querySelector('.imgv canvas') !== null);
      assert.equal(await editorOpen(), false, 'the second document opened with an editor carrying another document\'s draft');
      assert.equal(await page.locator('.imgv-editor textarea').count(), 0, 'a draft text area is visible in the second document');
      await placeNoteAt(0.4, 0.4);
      await page.fill('.imgv-editor textarea', 'omega draft');
      await openRow('board-photo.png');
      await page.waitForSelector('.imgv-editor');
      assert.equal(await editorValue(), 'gamma draft', 'the first document lost its own draft, or got the second one\'s');
      assert.deepEqual(await savedTexts('img2'), [], 'the second document received a note it never saved');
    });

    await check(tag('saving the restored draft stores it and clears the memory'), page, async () => {
      const before = (await savedTexts('img1')).length;
      await page.press('.imgv-editor textarea', 'Control+Enter'); // the keyboard save path; the open notes panel covers the button
      assert.equal(await editorOpen(), false, 'saving did not close the editor');
      assert.equal((await savedTexts('img1')).length, before + 1, 'saving did not add the note');
      assert.ok((await savedTexts('img1')).includes('gamma draft'), 'the saved note lost its text');
      await openRow('service-manual.pdf');
      await openRow('board-photo.png');
      await page.waitForTimeout(300);
      assert.equal(await editorOpen(), false, 'the saved draft came back on the next visit');
      assert.equal(await page.getByText(TEXT.restored, { exact: true }).count(), 0, 'the restored notice reappeared after saving');
    });

    await check(tag('a note removed elsewhere moves its unsaved text to a new note at the same point'), page, async () => {
      await openRow('board-photo.png');
      if (!(await page.locator('.imgv-row__main[title="alpha draft"]').count())) await page.click(`.imgv button[aria-label=${JSON.stringify(TEXT.panelLabel)}]`);
      await page.locator('.imgv-row__main[title="alpha draft"]').first().click(); // edit the saved note
      await page.waitForSelector('.imgv-editor');
      assert.equal(await page.locator('.imgv-editor').getAttribute('aria-label'), TEXT.editNote, 'the saved note did not open for editing');
      assert.equal((await page.locator('.imgv-editor__title').textContent()).trim(), TEXT.editNote, 'the edit-mode title is not the catalog text');
      await page.fill('.imgv-editor textarea', 'moved draft');
      // Another part of the workspace removes the note (the mock action the UI itself uses).
      await page.evaluate(() => {
        const img1 = window.__mock.state().documents.find(d => d.record.id === 'img1');
        window.__mock.actions.setAnnotations('img1', img1.record.annotations.filter(a => a.text !== 'alpha draft'));
      });
      await page.waitForFunction(label => document.querySelector('.imgv-editor')?.getAttribute('aria-label') === label, TEXT.newNote);
      assert.equal(await editorValue(), 'moved draft', 'the unsaved text was lost when its note disappeared');
      assertMessage(await alertText(), TEXT.moved, `[${lang}] moved message`);
      await page.press('.imgv-editor textarea', 'Control+Enter');
      assert.equal(await editorOpen(), false, 'saving the moved text did not close the editor');
      const notes = await savedTexts('img1');
      assert.ok(notes.includes('moved draft'), 'the moved text was not saved as a note');
      assert.ok(!notes.includes('alpha draft'), 'the removed note came back');
    });

    await check(tag('a removed document leaves no draft behind, even when it is added again'), page, async () => {
      await openRow('second-board.png');
      await placeNoteAt(0.6, 0.6);
      await page.fill('.imgv-editor textarea', 'zeta draft');
      await page.locator('.wsp-doc-main', { hasText: 'service-manual.pdf' }).first().click();
      await page.waitForSelector('[data-testid=document-viewer][data-kind=pdf]');
      await page.locator('.wsp-doc-line', { hasText: 'second-board.png' }).first().locator('[data-testid=remove-document]').click();
      await page.locator('[data-testid=remove-confirm]').first().click(); // the row asks first; the confirmation sits beside the row, not inside it
      await page.waitForFunction(() => !Array.from(document.querySelectorAll('.wsp-doc-main')).some(e => e.textContent.includes('second-board.png')));
      assert.equal(await page.evaluate(() => window.__mock.state().documents.some(d => d.record.id === 'img2')), false, 'the removed document is still in the workspace');
      await addImageDocument('img2', 'second-board.png');
      await page.waitForSelector('.wsp-doc-main:has-text("second-board.png")');
      await openRow('second-board.png');
      await page.waitForTimeout(300);
      assert.equal(await editorOpen(), false, 'a re-added document reopened the removed document\'s draft');
      assert.equal(await page.getByText(TEXT.restored, { exact: true }).count(), 0, 'a re-added document announced a removed draft');
    });

    await check(tag('a window reload clears the in-memory draft (documented limit)'), page, async () => {
      await openRow('board-photo.png');
      await placeNoteAt(0.35, 0.55);
      await page.fill('.imgv-editor textarea', 'reload draft');
      await page.reload();
      await page.waitForFunction(() => window.__mock !== undefined);
      await page.waitForSelector('[data-testid=tab-documents]');
      if (await page.locator('[data-testid=support-not-now]').count()) await page.click('[data-testid=support-not-now]');
      await openRow('board-photo.png');
      await page.waitForTimeout(300);
      assert.equal(await editorOpen(), false, 'a draft survived a reload, which the design does not promise');
    });

    await context.close();
  };

  // ---- narrow layouts and the English fallback: separate pages on the same synthetic core -----------------------------
  const pageRow = async (page, name) => {
    await page.click('[data-testid=tab-documents]');
    await page.locator('.wsp-doc-main', { hasText: name }).first().click();
    await page.waitForFunction(() => document.querySelector('.imgv canvas') !== null, null, { timeout: 15000 });
  };
  const pageNote = async (page, lang, fx, fy) => {
    await page.locator(`.imgv button[aria-label=${JSON.stringify(TEXTS[lang].addNote)}]`).first().click();
    if (page.viewportSize().height < 600) {
      // A short viewport leaves the stage a sliver under the hint, so the keyboard path is used: Enter picks a point at the view centre.
      await page.evaluate(() => document.querySelector('.imgv canvas')?.closest('[tabindex]')?.focus());
      await page.keyboard.press('Enter');
      await page.waitForSelector('.imgv-editor');
      return;
    }
    const box = await page.locator('.imgv canvas').first().boundingBox();
    const spots = [[fx, fy], [fx + 0.12, fy], [fx, fy + 0.1], [fx - 0.12, fy - 0.1], [fx + 0.12, fy + 0.1]];
    for (const [x, y] of spots) {
      await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
      await page.waitForSelector('.imgv-editor');
      if ((await page.locator('.imgv-editor button').count()) === 2) return; // a new note has Cancel and Save only; an edit also has Delete (no label is read here)
      await page.press('.imgv-editor textarea', 'Escape');
    }
    throw new Error('no empty spot for a new note near the requested point');
  };
  const pageSaved = (page, id) => page.evaluate(docId => (window.__mock.state().documents.find(d => d.record.id === docId)?.record.annotations ?? []).map(a => a.text), id);

  // Narrow configurations as WIDTHxHEIGHT: 560x940 (earlier run) and the targeted 400x400 viewport.
  const NARROW_CONFIGS = (process.env.TRACE_QA_NARROW_CONFIGS || '560x940,400x400').split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const [width, height] = s.split('x').map(Number);
    return { width, height };
  });
  const NARROW_LANGS = (process.env.TRACE_QA_NARROW_LANGS || 'de,uk,pl').split(',').map(s => s.trim()).filter(Boolean);
  const runNarrow = async (lang, cfg) => {
    const TEXT = TEXTS[lang];
    const NARROW_WIDTH = cfg.width;
    const tag = name => `[${lang}] narrow ${cfg.width}x${cfg.height}: ${name}`;
    const { context, page } = await open(lang, { width: cfg.width, height: cfg.height });
    // Reachable: rendered, inside the viewport, not covered by another element at its centre, and its label not clipped.
    const reachable = async (locator, label) => {
      const el = locator.first();
      assert.equal(await el.count(), 1, `${label}: not found`);
      // A short viewport makes the editor scroll inside itself; bring the control into view with the editor's own scroll only.
      await el.evaluate(node => { const editor = node.closest('.imgv-editor'); if (editor && editor.scrollHeight > editor.clientHeight) node.scrollIntoView({ block: 'nearest' }); });
      const box = await el.boundingBox();
      assert.ok(box && box.width > 0 && box.height > 0, `${label}: not rendered`);
      const vw = await page.evaluate(() => document.documentElement.clientWidth);
      assert.ok(box.x >= 0 && box.x + box.width <= vw, `${label}: outside the ${vw}px viewport`);
      const covered = await el.evaluate((node, [x, y]) => { const hit = document.elementFromPoint(x, y); return !(hit === node || node.contains(hit)); }, [box.x + box.width / 2, box.y + box.height / 2]);
      assert.ok(!covered, `${label}: covered by another element at its centre`);
      assert.ok(!(await el.evaluate(node => node.scrollWidth > node.clientWidth + 1)), `${label}: its label is clipped`);
    };
    await check(tag('the note tool and the new-note actions are reachable, unclipped and inside the viewport'), page, async () => {
      await pageRow(page, 'board-photo.png');
      await reachable(page.locator(`.imgv button[aria-label=${JSON.stringify(TEXT.addNote)}]`), `[${lang}] note tool`);
      await pageNote(page, lang, 0.4, 0.4);
      await page.fill('.imgv-editor textarea', 'narrow draft');
      const vw = await page.evaluate(() => document.documentElement.clientWidth);
      const editorBox = await page.locator('.imgv-editor').boundingBox();
      assert.ok(editorBox.x >= 0 && editorBox.x + editorBox.width <= vw, `[${lang}] the editor box leaves the ${vw}px viewport`);
      await reachable(page.locator('.imgv-editor button', { hasText: TEXT.cancel }), `[${lang}] new-note ${TEXT.cancel}`);
      await reachable(page.locator('.imgv-editor button', { hasText: TEXT.save }), `[${lang}] new-note ${TEXT.save}`);
      await page.locator('.imgv-editor button', { hasText: TEXT.save }).first().click();
      assert.deepEqual(await pageSaved(page, 'img1'), ['narrow draft'], 'the reachable Save did not store the note');
    });
    await check(tag('the edit-mode actions (Save, Cancel, Delete) are reachable and unclipped'), page, async () => {
      await reachable(page.locator(`.imgv button[aria-label=${JSON.stringify(TEXT.panelLabel)}]`), `[${lang}] notes-panel toggle`);
      if (!(await page.locator('.imgv-row__main', { hasText: 'narrow draft' }).count())) await page.click(`.imgv button[aria-label=${JSON.stringify(TEXT.panelLabel)}]`);
      const row = page.locator('.imgv-row__main', { hasText: 'narrow draft' }).first();
      // Below 600 px of height the shell itself overflows the viewport sideways (outside ImageViewer), so a keyboard user reaches the row: focus + Enter.
      if (cfg.height < 600) { await row.focus(); await page.keyboard.press('Enter'); } else await row.click();
      await page.waitForSelector('.imgv-editor');
      assert.equal(await page.locator('.imgv-editor').getAttribute('aria-label'), TEXT.editNote, 'the saved note did not open for editing');
      for (const label of [TEXT.del, TEXT.cancel, TEXT.save]) await reachable(page.locator('.imgv-editor button', { hasText: label }), `[${lang}] edit ${label}`);
      await page.locator('.imgv-editor button', { hasText: TEXT.cancel }).first().click();
      assert.equal(await page.locator('.imgv-editor').count(), 0, 'Cancel did not close the clean editor');
    });
    await context.close();
  };

  const runFallback = async () => {
    const lang = 'de';
    const englishKept = catalogFor('en')['notes.draftKept'];
    const tag = name => `[${lang}] fallback (notes.draftKept removed from ${lang} in this harness page only): ${name}`;
    const { context, page } = await open(lang, { query: '&dropLang=de&dropKey=notes.draftKept' });
    await check(tag('the missing key shows the English text, and the other German messages stay German'), page, async () => {
      assert.notEqual(englishKept, TEXTS.de.kept, 'the English and German texts must differ for this check to mean anything');
      await pageRow(page, 'board-photo.png');
      await pageNote(page, lang, 0.3, 0.3);
      await page.fill('.imgv-editor textarea', 'fallback draft');
      await pageNote(page, lang, 0.7, 0.6);
      assertMessage(await page.locator('.imgv-editor [role=alert]').first().textContent(), TEXTS.de.blocked, `[${lang}] blocked (German, key present)`);
      await page.press('.imgv-editor textarea', 'Escape');
      const shown = await page.locator('.imgv-editor [role=alert]').first().textContent();
      assert.equal(shown, englishKept, `[${lang}] the missing key did not fall back to the English text`);
      assert.ok(!shown.includes('notes.draft'), 'the raw key is shown');
      assert.equal(await page.locator('.imgv-editor textarea').inputValue(), 'fallback draft', 'the fallback changed the draft');
    });
    await context.close();
  };

  for (const lang of LANGS) await runLanguage(lang);
  for (const cfg of NARROW_CONFIGS) for (const lang of NARROW_LANGS) await runNarrow(lang, cfg);
  await runFallback();
  await browser.close();

  const failed = results.filter(r => !r.ok);
  const byLanguage = Object.fromEntries(LANGS.map(lang => {
    const rows = results.filter(r => r.name.startsWith(`[${lang}] `));
    return [lang, { passed: rows.filter(r => r.ok).length, failed: rows.filter(r => !r.ok).length, total: rows.length }];
  }));
  const summary = { base: BASE, languages: LANGS, keys: KEYS, texts: TEXTS, passed: results.length - failed.length, failed: failed.length, problems, byLanguage, results };
  fs.writeFileSync(path.join(OUT, 'image-draft-qa.json'), JSON.stringify(summary, null, 2));
  console.log(`\nimage-draft QA (${LANGS.join(',')}): ${summary.passed} passed, ${failed.length} failed, ${problems.length} page problems`);
  console.log(JSON.stringify(byLanguage));
  if (failed.length || problems.length) process.exit(1);
}

main().catch(error => { console.error('QA crashed:', error); process.exit(1); });
