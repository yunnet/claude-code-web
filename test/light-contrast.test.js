const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Claude runs under the `light-ansi` theme in light mode (ClaudeBridge.themeForUi),
// which means it draws its own chrome — the input box rules, the status line, the
// dim lines of a reply — out of OUR sixteen ANSI colours. So the light palette in
// splits.js is not decoration; it is the contrast of the UI, and a colour that
// slips under threshold there does not look wrong, it looks *missing*.
//
// These are static assertions over the sources, like overlay-stacking.test.js:
// the invariant is a contrast contract, and a contract you can check without a
// browser is one that stays checked.
describe('light theme contrast', function () {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const SPLITS = read('src', 'public', 'splits.js');
  const CSS = read('src', 'public', 'style.css');

  const WHITE = '#ffffff';

  function luminance(hex) {
    const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  // The light branch of getTerminalTheme(), as `{ name: '#rrggbb' }`. Parsed
  // rather than imported: splits.js is a browser script with no exports, and
  // the point is to check the file the browser actually loads.
  function lightPalette() {
    const start = SPLITS.indexOf('if (isLight) {');
    assert.ok(start > 0, 'getTerminalTheme() no longer has a light branch');
    const body = SPLITS.slice(start, SPLITS.indexOf('// Dark palette', start));
    const out = {};
    const re = /(\w+):\s*'(#[0-9a-fA-F]{6})'/g;
    let m;
    while ((m = re.exec(body)) !== null) out[m[1]] = m[2].toLowerCase();
    return out;
  }

  const ANSI = [
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
    'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'
  ];

  it('paints the light terminal on white', function () {
    // Every ratio below is measured against this. If the background moves, the
    // thresholds are measuring the wrong thing and this fails first.
    assert.strictEqual(lightPalette().background, WHITE);
  });

  it('clears 4.5:1 on white for every colour Claude uses as text', function () {
    // ANSI 7 is excluded and checked on its own below: it is the one slot Claude
    // also uses as a background, so it cannot be judged as text alone.
    const p = lightPalette();
    const weak = ANSI
      .filter((n) => n !== 'white')
      .map((n) => ({ n, hex: p[n], r: contrast(p[n], WHITE) }))
      .filter((c) => c.r < 4.5);
    assert.deepStrictEqual(weak, [], weak.map((c) => `${c.n} ${c.hex} ${c.r.toFixed(2)}:1`).join(', '));
  });

  it('makes ANSI 7 work as a rule AND as the band behind your message', function () {
    // Claude draws the input box rules with ANSI 7 as a foreground, and the band
    // behind your echoed message (plus its "Jump to bottom" pill) with ANSI 7 as
    // a background carrying ANSI 0. Both thresholds have to hold at once, and
    // they pull against each other — the product of the two ratios is exactly
    // contrast(ANSI 0, white), so this is a genuine trade, not an oversight.
    // Tuning ANSI 7 dark for the rules alone is what made the band unreadable.
    const p = lightPalette();
    const rule = contrast(p.white, WHITE);
    const band = contrast(p.black, p.white);
    assert.ok(rule >= 3, `ANSI 7 rules the input box at ${rule.toFixed(2)}:1 on white, want >= 3`);
    assert.ok(band >= 4.5, `ANSI 0 on ANSI 7 is ${band.toFixed(2)}:1, want >= 4.5`);
  });

  it('makes bright* darker than its base, the way a light background needs', function () {
    // The greys (0/7/8) are their own ramp and are checked below; every hue
    // pair follows this rule.
    const p = lightPalette();
    for (const base of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan']) {
      const bright = 'bright' + base[0].toUpperCase() + base.slice(1);
      const rb = contrast(p[base], WHITE);
      const rr = contrast(p[bright], WHITE);
      assert.ok(rr > rb, `${bright} (${rr.toFixed(2)}:1) must out-contrast ${base} (${rb.toFixed(2)}:1) on white`);
    }
  });

  it('keeps the three greys apart, darkest first', function () {
    // ANSI 0 / 8 / 7 are one ramp, and programs pick among them to say "loud",
    // "normal", "quiet". If two collapse onto each other the distinction Claude
    // is drawing with them is simply gone.
    const p = lightPalette();
    const [black, brightBlack, white] = ['black', 'brightBlack', 'white'].map((n) => contrast(p[n], WHITE));
    assert.ok(black > brightBlack, `black (${black.toFixed(2)}:1) must be darker than brightBlack (${brightBlack.toFixed(2)}:1)`);
    assert.ok(brightBlack > white, `brightBlack (${brightBlack.toFixed(2)}:1) must be darker than ANSI 7 (${white.toFixed(2)}:1)`);
  });

  it('keeps the light --border visible enough to shape a tab', function () {
    // .session-tab is --bg-tertiary on a --bg-secondary bar (1.10:1): the border
    // is the only thing that draws the tab. #e6e7eb (1.24:1) did not.
    const block = CSS.slice(CSS.indexOf('[data-theme="light"] {'));
    const border = /--border:\s*(#[0-9a-fA-F]{6})/.exec(block)[1];
    const r = contrast(border, WHITE);
    assert.ok(r >= 1.4, `light --border is ${r.toFixed(2)}:1 on white, want >= 1.4`);
  });
});
