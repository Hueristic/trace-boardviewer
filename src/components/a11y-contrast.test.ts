import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Contrast. Text colours already reach 4.5:1 in both themes. The form-control borders used the decorative --line
 * token, which is 1.2 to 1.5:1 against the surfaces. WCAG 1.4.11 needs 3:1 for a control boundary that identifies the
 * control, so the controls use --control-line, which meets 3:1 on every surface they sit on, in both themes.
 */
const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

function token(css: string, name: string): string {
  const match = css.match(new RegExp(`--${name}:(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`token --${name} is missing`);
  return match[1];
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function ratio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const styles = read('src/styles.css');
const [darkRoot, lightRoot] = styles.split('\n').slice(0, 2);

describe('control borders meet the non-text contrast requirement in both themes', () => {
  it.each([['dark', darkRoot], ['light', lightRoot]])('--control-line reaches 3:1 on bg, panel and raised in the %s theme', (_name, block) => {
    const control = token(block, 'control-line');
    for (const surface of ['bg', 'panel', 'raised']) {
      expect(ratio(control, token(block, surface)), `${control} on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('the text field, select and textarea borders use the control token, not the decorative line', () => {
    const controls: Array<[string, RegExp]> = [
      ['src/components/bug-report-dialog.css', /textarea\{[^}]*border:1px solid var\(--control-line\)/],
      ['src/components/image-viewer.css', /\.imgv-input\{[^}]*border:1px solid var\(--control-line\)/],
      ['src/components/library/devices-view.css', /\.devices-field input\{[^}]*border:1px solid var\(--control-line\)/],
      ['src/components/pdf-viewer.css', /\.pdfv-field input \{ height: 34px;[^}]*border: 1px solid var\(--control-line\)/],
      ['src/components/support-notice.css', /\.support-verification input \{[^}]*border: 1px solid var\(--control-line\)/],
      ['src/components/workspace/workspace.css', /\.wsp-measure-fields input\{[^}]*border:1px solid var\(--control-line\)/],
      ['src/components/workspace/workspace.css', /select select\{[^}]*border:1px solid var\(--control-line\)/],
      ['src/components/workspace/workspace.css', /\.wsp-link-form select,\.wsp-link-form input\[type=search\]\{[^}]*border:1px solid var\(--control-line\)/],
      ['src/styles.css', /\.settings-select\{[^}]*border:1px solid var\(--control-line\)/],
    ];
    for (const [file, pattern] of controls) {
      expect(read(file), file).toMatch(pattern);
    }
  });
});
