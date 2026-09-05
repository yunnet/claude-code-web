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

  it('holds ANSI 7 dark enough to draw a hairline', function () {
    // Claude rules the input box and the status line with ANSI 7 as a foreground.
    // A 1px box-drawing glyph reads far fainter than text at the same ratio: this
    // was reported invisible at 4.55:1 and again at 3.73:1, so the text threshold
    // is not the bar here. The band ANSI 7 also paints is handled below.
    const r = contrast(lightPalette().white, WHITE);
    assert.ok(r >= 6, `ANSI 7 is ${r.toFixed(2)}:1 on white, want >= 6`);
  });

  it('turns on the per-pair correction the dark ANSI 7 depends on', function () {
    // ANSI 7 is double-booked: a foreground for the rules, a background for the
    // band behind your echoed message (ANSI 0 on top). The two ratios multiply to
    // contrast(ANSI 0, white), a constant — so no single value serves both, and
    // splitting the difference is what failed twice. minimumContrastRatio fixes
    // the pair at draw time instead, which is what lets ANSI 7 be dark at all.
    // Without it, the band would render at 2.96:1.
    const p = lightPalette();
    const band = contrast(p.black, p.white);
    assert.ok(band < 4.5, `band is ${band.toFixed(2)}:1 — if it now clears 4.5 on its own, this guard is stale`);

    const m = /const LIGHT_MIN_CONTRAST_RATIO = ([\d.]+)/.exec(SPLITS);
    assert.ok(m, 'LIGHT_MIN_CONTRAST_RATIO is gone — the palette assumes it exists');
    assert.ok(Number(m[1]) >= 4.5, `minimum contrast is ${m[1]}, want >= 4.5`);
    // Light gets the correction, dark deliberately does not.
    assert.ok(/data-theme'\) === 'light' \? LIGHT_MIN_CONTRAST_RATIO : 1/.test(SPLITS),
      'getTerminalContrast should apply the correction to light only');
  });

  it('never sets a terminal palette without the correction beside it', function () {
    // The palette is only safe because the correction is on. Any site that
    // assigns options.theme by hand would reintroduce the unreadable band, so
    // theme assignment goes through applyTerminalPalette and nowhere else.
    const APP = read('src', 'public', 'app.js');
    for (const [name, src] of [['splits.js', SPLITS], ['app.js', APP]]) {
      const strays = (src.match(/\.options\.theme\s*=/g) || []).length;
      const inHelper = /function applyTerminalPalette\([^)]*\)\s*\{[^}]*\.options\.theme\s*=/.test(src) ? 1 : 0;
      assert.strictEqual(strays, inHelper,
        `${name} assigns options.theme outside applyTerminalPalette (${strays} assignment(s), ${inHelper} in the helper)`);
    }
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
