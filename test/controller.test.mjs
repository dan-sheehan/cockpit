import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../public/controller-core.js';

// A fake Gamepad in Chrome's "standard" shape: 18 buttons, 4 axes.
const pad = (pressed = [], axes = [0, 0, 0, 0], values = {}) => ({ id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, mapping: 'standard', connected: true, timestamp: 1,
  buttons: [...core.BUTTONS, 'share'].map((n, i) => ({ pressed: pressed.includes(n) || (values[n] ?? 0) > 0.5, value: values[n] ?? (pressed.includes(n) ? 1 : 0) })), axes });
const norm = (...a) => core.normalize(core.snapshot(pad(...a)));
const run = (frames) => { let st = core.initialState(); const out = []; for (const [n, t] of frames) { const r = core.step(st, n, t); st = r.state; out.push(...r.events.map((e) => ({ ...e, t }))); } return { state: st, events: out }; };

test('snapshot copies the live gamepad into plain data and normalize names the standard layout', () => {
  const n = norm(['a'], [0.5, -0.5, 0, 0], { rt: 0.4 });
  assert.equal(n.standard, true); assert.equal(n.buttons.a.pressed, true); assert.equal(n.buttons.a.raw, 'button[0]'); assert.equal(n.buttons.b.pressed, false);
  assert.equal(n.triggers.rt.value, 0.4); assert.equal(n.triggers.rt.engaged, true); assert.equal(n.triggers.lt.engaged, false);
  assert.ok(n.sticks.left.active); assert.equal(n.sticks.left.raw.x, 0.5);
});

test('non-standard mappings yield raw only: no named buttons, no events', () => {
  const gp = { ...pad(['a']), mapping: '' }; const n = core.normalize(core.snapshot(gp));
  assert.equal(n.standard, false); assert.deepEqual(n.buttons, {}); assert.equal(n.sticks, null);
  const { events } = run([[n, 0], [n, 100]]); assert.deepEqual(events, []);
});

test('lastChanged picks the largest raw delta across buttons and axes, including releases', () => {
  const idle = core.snapshot(pad());
  const pressed = core.snapshot(pad(['a'], [0, -0.8, 0, 0], { rt: 0.4 }));
  assert.deepEqual(core.lastChanged(idle, pressed), { kind: 'button', index: 0, value: 1, prev: 0 });
  assert.deepEqual(core.lastChanged(pressed, idle), { kind: 'button', index: 0, value: 0, prev: 1 });
  const axis = core.snapshot(pad([], [0, -0.8, 0, 0], { rt: 0.4 }));
  assert.deepEqual(core.lastChanged(idle, axis), { kind: 'axis', index: 1, value: -0.8, prev: 0 });
  assert.deepEqual(core.lastChanged(axis, idle), { kind: 'axis', index: 1, value: 0, prev: -0.8 });
});

test('lastChanged ignores axis noise below 0.02, includes the boundary, and keeps small button changes', () => {
  const idle = core.snapshot(pad());
  assert.equal(core.lastChanged(idle, core.snapshot(pad([], [0.019, -0.019, 0, 0]))), null);
  assert.deepEqual(core.lastChanged(core.snapshot(pad([], [0.1, 0, 0, 0])), core.snapshot(pad([], [0.12, 0, 0, 0]))), { kind: 'axis', index: 0, value: 0.12, prev: 0.1 });
  assert.deepEqual(core.lastChanged(idle, core.snapshot(pad([], [0.019, 0, 0, 0], { lt: 0.01 }))), { kind: 'button', index: 6, value: 0.01, prev: 0 });
});

test('lastChanged needs consecutive snapshots of the same pad and returns null while held', () => {
  const held = core.snapshot(pad(['a']));
  assert.equal(core.lastChanged(null, held), null); assert.equal(core.lastChanged(held, null), null);
  assert.equal(core.lastChanged(held, held), null);
  assert.equal(core.lastChanged(held, { ...held, id: 'another pad' }), null);
  assert.equal(core.lastChanged(held, { ...held, index: 1 }), null);
});

test('lastChanged reports unnamed raw inputs without relying on a standard mapping', () => {
  const before = core.snapshot({ ...pad(), mapping: '', buttons: [...pad().buttons, { pressed: false, value: 0 }], axes: [0, 0, 0, 0, 0] });
  const after = structuredClone(before); after.buttons[17] = { pressed: true, value: 1 };
  assert.deepEqual(core.lastChanged(before, after), { kind: 'button', index: 17, value: 1, prev: 0 });
  after.buttons[17].value = 0; after.axes[4] = -0.9;
  assert.deepEqual(core.lastChanged(before, after), { kind: 'axis', index: 4, value: -0.9, prev: 0 });
});

test('dead zone: rest drift is zero, edge of the zone maps to 0, full deflection maps to 1, direction preserved', () => {
  assert.deepEqual(core.normalizeStick(0.04, -0.03), { x: 0, y: 0, magnitude: 0, active: false });
  assert.equal(core.normalizeStick(core.DEAD_ZONE, 0).x, 0);
  assert.equal(core.normalizeStick(1, 0).x, 1); assert.equal(core.normalizeStick(0, -1).y, -1);
  const s = core.normalizeStick(0.5, 0.5); assert.ok(s.magnitude > 0 && s.magnitude < 1); assert.ok(Math.abs(s.x - s.y) < 1e-9);
  assert.equal(core.normalizeAxis(0.1), 0); assert.equal(core.normalizeAxis(-1), -1); assert.equal(core.normalizeAxis(0.56), 0.5);
});

test('stick navigation has hysteresis: engages at 0.6, holds until below 0.4, and drift never navigates', () => {
  const raw = (m) => m * (1 - core.DEAD_ZONE) + core.DEAD_ZONE; // raw deflection that normalizes to magnitude m
  const seq = [[norm([], [0, -raw(0.3), 0, 0]), 0], [norm([], [0, -raw(0.7), 0, 0]), 16], [norm([], [0, -raw(0.5), 0, 0]), 32], [norm([], [0, -raw(0.3), 0, 0]), 48], [norm([], [0, -0.05, 0, 0]), 64]];
  const { events } = run(seq); const nav = events.filter((e) => e.event.startsWith('controller.nav'));
  assert.equal(nav.length, 1); assert.equal(nav[0].event, 'controller.nav.up'); assert.equal(nav[0].source, 'stick'); assert.equal(nav[0].t, 16);
  const drift = run([[norm([], [0.03, 0.02, 0, 0]), 0], [norm([], [-0.04, 0.05, 0, 0]), 16], [norm([], [0.11, -0.1, 0, 0]), 32]]); assert.deepEqual(drift.events, []);
});

test('button press is edge-triggered: holding A produces one select, not one per frame', () => {
  const a = norm(['a']), idle = norm();
  const { events } = run([[idle, 0], [a, 16], [a, 32], [a, 500], [a, 1000], [idle, 1016], [a, 1032]]);
  assert.deepEqual(events.map((e) => e.event), ['controller.select', 'controller.select']);
  assert.equal(events[0].raw, 'button[0]'); assert.equal(events[0].physical, 'A pressed');
});

test('D-pad repeats after the delay at the interval and stops on release', () => {
  const down = norm(['down']), idle = norm(); const frames = [[idle, 0]]; for (let t = 16; t <= 800; t += 16) frames.push([down, t]); frames.push([idle, 816], [idle, 1200]);
  const { events } = run(frames); const nav = events.filter((e) => e.event === 'controller.nav.down');
  assert.equal(nav[0].repeat, undefined); assert.equal(nav[0].t, 16);
  assert.ok(nav[1].repeat); assert.ok(nav[1].t >= 16 + core.REPEAT_DELAY && nav[1].t < 16 + core.REPEAT_DELAY + 16, `first repeat at ${nav[1].t}`);
  const gaps = nav.slice(2).map((e, i) => e.t - nav[i + 1].t); assert.ok(gaps.every((g) => g >= core.REPEAT_INTERVAL && g < core.REPEAT_INTERVAL + 16), `gaps ${gaps}`);
  assert.equal(events.filter((e) => e.t > 816).length, 0);
});

test('triggers emit engage/release transitions only, with the analog value', () => {
  const frames = [[norm(), 0]]; for (let i = 1; i <= 10; i++) frames.push([norm([], [0, 0, 0, 0], { rt: i / 10 }), i * 16]); frames.push([norm(), 200]);
  const { events } = run(frames); assert.deepEqual(events.map((e) => e.event), ['controller.rt.engage', 'controller.rt.release']);
  assert.equal(events[0].value, 0.2); assert.equal(core.resolve('controller.rt.engage').action, 'cockpit.scrollDown');
});

test('disconnect while holding D-pad releases the hold: reconnect does not resume repeats', () => {
  const down = norm(['down']); const { state, events } = run([[norm(), 0], [down, 16], [null, 32], [down, 2000], [down, 2100]]);
  assert.deepEqual(events.map((e) => e.event), ['controller.nav.down', 'controller.nav.down']); assert.equal(events[1].repeat, undefined);
  assert.ok(state.held.down);
});

test('a 16-button standard layout (no Xbox button) still normalizes and steps (F4)', () => {
  const gp = pad(['a']); gp.buttons = gp.buttons.slice(0, 16); const n = core.normalize(core.snapshot(gp));
  assert.equal(n.standard, true); assert.equal(n.buttons.xbox, undefined);
  const { events } = run([[core.normalize(core.snapshot({ ...gp, buttons: gp.buttons.map((b) => ({ ...b, pressed: false, value: 0 })) })), 0], [n, 16]]);
  assert.deepEqual(events.map((e) => e.event), ['controller.select']);
});

test('accepted raw button indices resolve to the existing app actions', () => {
  const expected = { 0: 'activateSelected', 1: 'back', 4: 'prevView', 5: 'nextView', 6: 'scrollUp', 7: 'scrollDown', 8: 'openController', 9: 'openNewTask', 12: 'selectPrev', 13: 'selectNext', 14: 'prevTab', 15: 'nextTab' };
  for (const [index, action] of Object.entries(expected)) {
    const gp = pad(); gp.buttons[index] = { pressed: true, value: 1 };
    const { events } = run([[norm(), 0], [core.normalize(core.snapshot(gp)), 16]]);
    assert.deepEqual(events.map((e) => core.resolve(e.event)?.action), ['cockpit.' + action], index);
    assert.equal(events[0].raw, `button[${index}]`);
  }
  assert.equal(core.MAPPINGS.length, Object.keys(expected).length);
  for (const event of ['arm', 'confirm', 'disarm']) assert.equal(core.resolve('controller.' + event), null);
});

test('diagnostic inputs never dispatch actions, including held Y followed by A', () => {
  for (const button of ['x', 'y', 'ls', 'rs', 'xbox', 'share']) {
    const gp = pad([button]);
    const { events, state } = run([[norm(), 0], [core.normalize(core.snapshot(gp)), 16], [core.normalize(core.snapshot(gp)), 5000], [norm(), 5016], [norm(['a']), 5032]]);
    assert.deepEqual(events.filter((e) => core.resolve(e.event)).map((e) => core.resolve(e.event).action), ['cockpit.activateSelected'], button);
    assert.ok(!('armed' in state));
    assert.equal(core.lastChanged(core.snapshot(pad()), core.snapshot(gp)).kind, 'button');
  }
  assert.deepEqual(run([[norm(), 0], [norm([], [0, 0, 1, -1]), 16]]).events, []);
  assert.deepEqual(run([[norm(), 0], [norm(['y']), 16], [norm(['y', 'a']), 5000]]).events.map((e) => e.event), ['controller.y', 'controller.select']);
});

test('left stick directions resolve to the same row and tab actions as D-pad', () => {
  for (const [axes, action] of [[[0, -1, 0, 0], 'selectPrev'], [[0, 1, 0, 0], 'selectNext'], [[-1, 0, 0, 0], 'prevTab'], [[1, 0, 0, 0], 'nextTab']]) {
    const { events } = run([[norm(), 0], [norm([], axes), 16]]);
    assert.deepEqual(events.map((e) => core.resolve(e.event)?.action), ['cockpit.' + action]);
  }
});

// Navigation contract: run the production action implementations (app.js) against a small DOM fixture with focus semantics.
const { readFileSync } = await import('node:fs');
const { runInNewContext } = await import('node:vm');
const navigationSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const navigationCode = navigationSource.slice(navigationSource.indexOf('// ---------- application navigation actions'), navigationSource.indexOf('// ---------- SEARCH'));
const goCode = navigationSource.slice(navigationSource.indexOf('function go(view'), navigationSource.indexOf('\n', navigationSource.indexOf('function go(view')));
const ROW_SEL = '#main .row[data-key]';
function navigationFixture() {
  const state = { route: { view: 'skills', id: null, tab: null }, runs: new Map(), focusKey: null };
  const effects = []; const pane = { scrollTop: 100 }, body = { scrollTop: 200 };
  const fixture = { rows: [], tabs: [], pane, body, focused: true };
  const classes = (...names) => { const set = new Set(names); return { add: (n) => set.add(n), remove: (n) => set.delete(n), contains: (n) => set.has(n) }; };
  const document = { activeElement: null, hasFocus: () => fixture.focused, addEventListener() {}, getElementById: () => null,
    querySelectorAll: (selector) => { if (selector === ROW_SEL) return fixture.rows; if (selector === '#main .tabs div') return fixture.tabs; if (selector === '#nav .item') return []; throw new Error('unexpected selector: ' + selector); },
    querySelector: (selector) => { const m = selector.match(/^#main \.row\[data-key\]\[data-key="(.*)"\]$/); if (m) return fixture.rows.find((r) => r.dataset.key === m[1]) || null; if (selector === '#main .split > :last-child') return fixture.pane; if (selector === '#main .viewbody') return fixture.body; throw new Error('unexpected selector: ' + selector); } };
  const makeRow = (name, selected = false) => { const r = { tagName: 'DIV', textContent: name, dataset: { run: name, key: name }, classList: classes(...(selected ? ['sel'] : [])), querySelector: () => ({ textContent: name }), scrollIntoView: (o) => effects.push(['scroll', name, o.block]), click: () => { effects.push(['click', name]); state.route.id = name; }, focus: (o) => { document.activeElement = r; effects.push(['focus', name, !!o?.preventScroll]); state.focusKey = name; } }; return r; };
  fixture.rows = [makeRow('first'), makeRow('second', true), makeRow('third')];
  fixture.tabs = ['overview', 'git', 'act'].map((name, i) => ({ textContent: name, classList: classes(...(i === 0 ? ['active'] : [])), click: () => { fixture.tabs.forEach((t) => t.classList.remove('active')); fixture.tabs.find((t) => t.textContent === name).classList.add('active'); state.route.tab = name; effects.push(['tab', name]); } }));
  const location = { hash: '#skills' }, window = { addEventListener() {} };
  const context = { window, document, S: state, core, location, CSS: { escape: (s) => s }, encodeURIComponent, VIEWS: [['skills', 'Skills'], ['projects', 'Projects'], ['runs', 'Processes'], ['controller', 'Controller']], go: (view, id = null, tab = null) => { if (view !== state.route.view) state.focusKey = null; state.route = { view, id, tab }; effects.push(['go', view, id, tab]); }, render: () => effects.push(['render']), history: { back: () => effects.push(['back']) } };
  runInNewContext(navigationCode, context);
  return { context, document, ...fixture, fixture, state, effects, actions: window.Cockpit.actions, app: window.Cockpit, makeRow, rowAttrs: context.rowAttrs, input: { tagName: 'INPUT' } };
}
const focusedName = (f) => f.document.activeElement?.dataset.key ?? null;

test('B2 focus: rows move real DOM focus from the selection, clamp at the ends, and remember the key', () => {
  const f = navigationFixture();
  assert.equal(f.actions['cockpit.selectNext'](), 'focus → row 3/3: third'); assert.equal(focusedName(f), 'third'); assert.equal(f.state.focusKey, 'third');
  assert.equal(f.actions['cockpit.selectNext'](), 'focus → row 3/3: third');
  assert.equal(f.actions['cockpit.selectPrev'](), 'focus → row 2/3: second');
  f.actions['cockpit.selectPrev'](); assert.equal(f.actions['cockpit.selectPrev'](), 'focus → row 1/3: first'); assert.equal(focusedName(f), 'first');
  assert.deepEqual(f.effects.filter(([e]) => e === 'focus')[0], ['focus', 'third', true]); assert.deepEqual(f.effects.filter(([e]) => e === 'scroll')[0], ['scroll', 'third', 'nearest']);
  const unselected = navigationFixture(); unselected.rows[1].classList.remove('sel');
  assert.equal(unselected.actions['cockpit.selectNext'](), 'focus → row 1/3: first'); assert.equal(unselected.actions['cockpit.selectPrev'](), 'focus → row 1/3: first');
  f.fixture.rows = []; assert.equal(f.actions['cockpit.selectNext'](), 'no list rows in this view');
});

test('B2 focus: activation clicks only the focused row; without focus it focuses the selection instead of clicking', () => {
  const f = navigationFixture();
  assert.equal(f.actions['cockpit.activateSelected'](), 'focus → row 2/3: second'); assert.equal(f.effects.filter(([e]) => e === 'click').length, 0);
  assert.equal(f.actions['cockpit.activateSelected'](), 'opened: second'); assert.equal(f.state.route.id, 'second'); assert.equal(f.effects.filter(([e]) => e === 'click').length, 1);
  f.fixture.rows = []; f.document.activeElement = null; assert.equal(f.actions['cockpit.activateSelected'](), 'no list rows in this view');
});

test('B2 focus: navigation resumes from the remembered row when focus is elsewhere, and is ignored inside text fields', () => {
  const f = navigationFixture(); f.actions['cockpit.selectNext'](); f.document.activeElement = null;
  assert.equal(f.actions['cockpit.selectPrev'](), 'focus → row 2/3: second');
  f.document.activeElement = f.input;
  for (const a of ['cockpit.selectPrev', 'cockpit.selectNext', 'cockpit.activateSelected', 'cockpit.prevTab', 'cockpit.nextTab']) assert.equal(f.actions[a](), 'ignored: text field focused', a);
  assert.equal(f.document.activeElement, f.input); assert.equal(f.state.focusKey, 'second'); assert.equal(f.effects.filter(([e]) => e === 'click' || e === 'tab').length, 0);
  assert.equal(f.actions['cockpit.prevView'](), 'view → Controller');   // view/back actions are not row navigation and still work
});

test('B2 focus: rowAttrs makes a row focusable and Enter/Space activate through its own click', () => {
  const f = navigationFixture(); const attrs = f.rowAttrs('k1');
  assert.equal(attrs['data-key'], 'k1'); assert.equal(attrs.tabindex, '0'); assert.equal(typeof attrs.onkeydown, 'function'); assert.equal(typeof attrs.onfocus, 'function');
  const clicks = []; const prevented = []; const row = { click: () => clicks.push(1), dataset: { key: 'k1' } };
  const press = (key) => attrs.onkeydown({ key, currentTarget: row, preventDefault: () => prevented.push(key) });
  press('Enter'); press(' '); press('ArrowDown'); press('a');
  assert.equal(clicks.length, 2); assert.deepEqual(prevented, ['Enter', ' ']);
  attrs.onfocus({ currentTarget: row }); assert.equal(f.state.focusKey, 'k1');
});

test('B2 focus: a re-render restores focus only when an eligible row owned it, and drops the key when the row is gone', () => {
  const f = navigationFixture(); f.actions['cockpit.selectNext']();
  let owned = f.app.focusOwner(); assert.equal(owned, 'third');
  f.fixture.rows = [f.makeRow('second'), f.makeRow('third')]; f.document.activeElement = null;   // render() replaced the DOM
  f.app.restoreFocus(owned); assert.equal(focusedName(f), 'third'); assert.deepEqual(f.effects.at(-1), ['focus', 'third', true]);
  // focus in the search box: the remembered key survives, focus is not stolen
  f.document.activeElement = f.input; owned = f.app.focusOwner(); assert.equal(owned, null);
  f.fixture.rows = [f.makeRow('third')]; f.app.restoreFocus(owned); assert.equal(f.document.activeElement, f.input); assert.equal(f.state.focusKey, 'third');
  // focus on nothing eligible: not restored, key kept while the row exists
  f.document.activeElement = null; f.app.restoreFocus(f.app.focusOwner()); assert.equal(focusedName(f), null); assert.equal(f.state.focusKey, 'third');
  // the row disappeared: remembered key cleared
  f.fixture.rows = [f.makeRow('other')]; f.app.restoreFocus(null); assert.equal(f.state.focusKey, null);
  assert.equal(f.actions['cockpit.selectNext'](), 'focus → row 1/1: other');
});

test('B2 focus: go() clears the remembered row on a view change and keeps it within the view', () => {
  const f = navigationFixture(); f.actions['cockpit.selectNext']();
  runInNewContext(goCode, f.context); const go = f.context.go;
  go('skills', 'third'); assert.equal(f.state.focusKey, 'third'); assert.equal(f.context.location.hash, 'skills/third');
  go('projects'); assert.equal(f.state.focusKey, null); assert.equal(JSON.stringify(f.state.route), JSON.stringify({ view: 'projects', id: null, tab: null }));
});

test('B2 focus: the focus set is exactly the data-key rows and never a button, link, input or select', () => {
  const src = navigationSource;
  assert.equal((src.match(/rowAttrs\(/g) || []).length, 8, 'one helper definition and seven navigation row producers');
  for (const site of ["rowAttrs(s.id), onclick: () => go('skills', s.id)", "rowAttrs(i.path) : {}), onclick: () => i.exists && go('instructions', i.path)", "rowAttrs(a.path), onclick: () => go('agents', a.path)", "rowAttrs(p.path), onclick: () => go('projects', p.path)", "rowAttrs(t.path), onclick: () => go('transcripts', t.path)", "rowAttrs(r.id), onclick: () => go('runs', r.id)", "rowAttrs(s.id) : {}), onclick: () => go('sessions', s.id)"]) assert.ok(src.includes(site), site);
  assert.ok(!/h\('(button|a|input|select|textarea)',[^)]*rowAttrs/.test(src));
  assert.ok(!src.includes('gp-cursor') && !src.includes('MutationObserver'), 'private cursor removed');
  assert.ok(src.includes("if (view !== S.route.view) S.focusKey = null; S.route = { view, id, tab }"), 'go() clears focus on view change');
  assert.ok(!/ArrowUp|ArrowDown/.test(src), 'no global arrow-key shortcuts');
  const adapter = readFileSync(new URL('../public/controller.js', import.meta.url), 'utf8'); assert.ok(!adapter.includes('updateControllerCursor'));
  assert.ok(!adapter.includes('.click(') && !adapter.includes('post('), 'the adapter never clicks or posts; only Cockpit.actions');
});

test('navigation contract: tab and view wrapping, file back and diagnostic/form navigation', () => {
  const f = navigationFixture();
  assert.equal(f.actions['cockpit.prevTab'](), 'tab → act'); assert.equal(f.state.route.tab, 'act');
  assert.equal(f.actions['cockpit.nextTab'](), 'tab → overview');
  f.fixture.tabs = []; assert.equal(f.actions['cockpit.nextTab'](), 'no tabs in this view');
  assert.equal(f.actions['cockpit.prevView'](), 'view → Controller'); assert.equal(f.state.route.view, 'controller');
  assert.equal(f.actions['cockpit.nextView'](), 'view → Skills');
  f.state.route.tab = 'file:/example'; assert.equal(f.actions['cockpit.back'](), 'closed file viewer');
  assert.equal(f.state.route.tab, null); assert.deepEqual(f.effects.at(-1), ['render']);
  assert.equal(f.actions['cockpit.back'](), 'history.back() from #skills'); assert.deepEqual(f.effects.at(-1), ['back']);
  assert.equal(f.actions['cockpit.openController'](), 'view → Controller');
  const count = f.effects.length; assert.equal(f.actions['cockpit.openController'](), 'already on Controller'); assert.equal(f.effects.length, count);
  assert.equal(f.actions['cockpit.openNewTask'](), 'view → Workflows · new task form (nothing started)');
  assert.equal(f.state.route.view, 'sessions'); assert.equal(f.state.route.id, 'new');
});

test('navigation contract: scrolling descriptions retain detail-pane fallback', () => {
  const f = navigationFixture();
  assert.equal(f.actions['cockpit.scrollUp'](), 'scrolling detail pane up · speed follows LT value');
  assert.equal(f.actions['cockpit.scrollDown'](), 'scrolling detail pane down · speed follows RT value');
  f.fixture.pane = null; assert.equal(f.actions['cockpit.scrollUp'](), 'scrolling view up · speed follows LT value');
});

test('extracted scrolling changes only the existing pane, with the same fallback and no-pane behavior', () => {
  const f = navigationFixture();
  f.actions['cockpit.scrollDetail'](7); assert.equal(f.pane.scrollTop, 107); assert.equal(f.body.scrollTop, 200);
  f.fixture.pane = null; f.actions['cockpit.scrollDetail'](-7); assert.equal(f.body.scrollTop, 193);
  f.fixture.body = null; assert.doesNotThrow(() => f.actions['cockpit.scrollDetail'](7));
});

test('browser adapter delegates navigation once per press and scrolls once per active frame', () => {
  const f = navigationFixture(); let gamepads = [], time = 0;
  const calls = [];
  for (const [name, action] of Object.entries(f.actions)) f.actions[name] = (...args) => { calls.push([name, ...args]); return action(...args); };
  Object.assign(f.context, { navigator: { getGamepads: () => gamepads }, performance: { now: () => time }, requestAnimationFrame() {}, sessionStorage: { getItem: () => null, setItem() {} } });
  const adapter = readFileSync(new URL('../public/controller.js', import.meta.url), 'utf8').replace("import * as core from './controller-core.js';", '');
  runInNewContext(adapter, f.context);
  const frame = (gp, at) => { gamepads = gp ? [gp] : []; time = at; f.context.window.CockpitController.tick(); };
  frame(pad(), 0); frame(pad(['a']), 16);
  for (let t = 32; t <= 1000; t += 16) frame(pad(['a']), t);
  assert.equal(calls.filter(([name]) => name === 'cockpit.activateSelected').length, 1);
  assert.equal(focusedName(f), 'second'); assert.equal(f.effects.filter(([name]) => name === 'click').length, 0);   // first A: focus lands on the selection
  frame(pad(), 1016); frame(pad(['a']), 1032);
  assert.equal(calls.filter(([name]) => name === 'cockpit.activateSelected').length, 2); assert.equal(f.effects.filter(([name]) => name === 'click').length, 1);
  f.fixture.focused = false; frame(pad(), 1048); frame(pad(['a']), 1064);
  assert.equal(calls.filter(([name]) => name === 'cockpit.activateSelected').length, 2);
  f.fixture.focused = true; frame(pad(), 1080); calls.length = 0;
  for (let t = 1100; t < 1148; t += 16) frame(pad([], [0, 0, 0, 0], { rt: 0.5 }), t);
  assert.equal(calls.filter(([name]) => name === 'cockpit.scrollDown').length, 1);
  assert.deepEqual(calls.filter(([name]) => name === 'cockpit.scrollDetail'), Array.from({ length: 3 }, () => ['cockpit.scrollDetail', 7]));
  assert.equal(f.pane.scrollTop, 121);
  frame(pad(), 1164); assert.equal(f.pane.scrollTop, 121);
  frame(pad(['y']), 1180); frame(pad(['y']), 6180); frame(pad(['y', 'a']), 6196);
  assert.equal(calls.filter(([name]) => name === 'cockpit.activateSelected').length, 1);
  assert.ok(!calls.some(([name]) => /stop|arm/i.test(name)));
  assert.equal(f.context.window.CockpitController.state.history.find((e) => e.event === 'controller.y').action, null);
  frame(pad(), 6212); calls.length = 0;
  frame(pad([], [0, 0, 0, 0], { lt: 0.5 }), 6228);
  assert.deepEqual(calls, [['cockpit.scrollUp'], ['cockpit.scrollDetail', -7]]);
  frame(pad(), 6244);
  frame(pad(['down']), 6260); assert.equal(focusedName(f), 'third');   // D-pad moves DOM focus through the same registry
});

