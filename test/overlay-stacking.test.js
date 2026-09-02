const assert = require('assert');
const fs = require('fs');
const path = require('path');

// The start/connect overlay is fixed, full-viewport, and at z-index 5000. The
// tab bar was at 2, so an idle session made every tab-bar control unclickable —
// switch, double-click rename, new, close, and all three toolbar buttons. These
// are static assertions over the sources: the invariant is a stacking contract,
// and a contract you can check without a browser is one that stays checked.
describe('overlay stacking', function () {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const CSS = read('src', 'public', 'style.css');
  const APP = read('src', 'public', 'app.js');

  const OVERLAY_Z = 5000;

  // z-index of a selector's LAST declaration, which is the one that wins for
  // rules at equal specificity.
  function zIndexOf(selector) {
    const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*?z-index:\\s*(\\d+)`, 'g');
    let m, last = null;
    while ((m = re.exec(CSS)) !== null) last = Number(m[1]);
    return last;
  }

  it('pins the overlay at the z-index the fix is written against', function () {
    // Every number below is relative to this one. If the overlay ever moves,
    // this test fails first and says so, instead of the chrome silently
    // sinking back underneath it.
    assert.strictEqual(zIndexOf('.terminal-overlay'), OVERLAY_Z);
  });

  it('lifts the tab bar and the two stacks it would otherwise invert', function () {
    const bar = zIndexOf('body.overlay-open .session-tabs-bar');
    const menu = zIndexOf('body.overlay-open .mobile-menu');
    const browser = zIndexOf('body.overlay-open .folder-browser-modal');

    assert.ok(bar > OVERLAY_Z, `tab bar (${bar}) must clear the overlay (${OVERLAY_Z})`);
    // Lifting the bar unconditionally would drop the mobile side menu (3000)
    // and the centered folder browser (2000) behind it. Inside the scope they
    // have to come along, above the bar.
    assert.ok(menu > bar, `mobile menu (${menu}) must stay above the tab bar (${bar})`);
    assert.ok(browser > bar, `folder browser (${browser}) must stay above the tab bar (${bar})`);
  });

  it('keeps the lift scoped, so normal stacking is untouched', function () {
    // The unscoped rules must NOT have grown a z-index of their own: outside
    // the overlay state, the mobile menu and folder browser still have to sit
    // above a tab bar that is back down at its ordinary level.
    assert.ok(zIndexOf('.session-tabs-bar') === null || zIndexOf('.session-tabs-bar') < zIndexOf('.mobile-menu'),
      'unscoped tab bar stays below the mobile menu');
    for (const rule of ['.session-tabs-bar', '.mobile-menu', '.folder-browser-modal']) {
      assert.ok(new RegExp(`body\\.overlay-open ${rule.replace('.', '\\.')}\\s*\\{`).test(CSS),
        `${rule} is lifted only under body.overlay-open`);
    }
  });

  it('leaves the file explorer drawer on top of everything it was lifted over', function () {
    // #fileExplorerModal is an id selector (1,0,0) and outranks
    // `body.overlay-open .folder-browser-modal` (0,2,1) despite sharing the
    // class — so the drawer must still win on the number too.
    const drawer = zIndexOf('#fileExplorerModal');
    assert.ok(drawer > OVERLAY_Z, 'the drawer still clears the overlay');
    assert.ok(drawer > zIndexOf('body.overlay-open .folder-browser-modal'),
      'the drawer outranks the scoped folder-browser lift');
  });

  it('toggles the flag in both directions, from the only two writers', function () {
    // A flag that is added but never removed leaves the chrome floating above
    // a dismissed overlay for the rest of the session.
    assert.ok(/showOverlay\([\s\S]*?classList\.add\('overlay-open'\)/.test(APP), 'showOverlay adds the flag');
    assert.ok(/hideOverlay\([\s\S]*?classList\.remove\('overlay-open'\)/.test(APP), 'hideOverlay removes the flag');
    // And those two really are the only places the overlay's display is set,
    // which is what makes the flag impossible to desync.
    const writers = (APP.match(/overlay\.style\.display\s*=/g) || []).length;
    assert.strictEqual(writers, 2, 'exactly two writers of the overlay display');
  });
});
