/* Cockpit controller core. Pure functions, no DOM: raw gamepad snapshot → normalized state → named controller events → Cockpit action names.
   Loaded by public/controller.js in the browser and by test/controller.test.mjs in node. */

export const DEAD_ZONE = 0.12;           // radial stick dead zone (this controller's rest drift observed at ≤ 0.04)
export const STICK_NAV_ON = 0.6;         // stick magnitude that counts as a digital nav press
export const STICK_NAV_OFF = 0.4;        // hysteresis: below this the nav press is released
export const TRIGGER_ON = 0.15;          // analog trigger counts as engaged above this
export const REPEAT_DELAY = 350;         // ms before a held nav input repeats
export const REPEAT_INTERVAL = 110;      // ms between repeats

// W3C "standard" gamepad mapping, which Chrome on macOS reports for the Xbox Wireless Controller.
export const BUTTONS = ['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'view', 'menu', 'ls', 'rs', 'up', 'down', 'left', 'right', 'xbox'];
export const AXES = ['lx', 'ly', 'rx', 'ry'];
export const NAV_BUTTONS = ['up', 'down', 'left', 'right'];

/** Copy the live Gamepad object into plain data (the browser object is a live view and cannot be diffed later). */
export function snapshot(gp) {
  if (!gp) return null;
  return { id: gp.id, index: gp.index, mapping: gp.mapping, connected: gp.connected, timestamp: gp.timestamp,
    buttons: Array.from(gp.buttons, (b) => ({ pressed: !!b.pressed, value: round(b.value) })), axes: Array.from(gp.axes, round) };
}
const round = (v) => Math.round((Number(v) || 0) * 1000) / 1000;

/** Largest raw value change between comparable snapshots; a first frame is a baseline, not an input. */
export function lastChanged(prevSnap, snap) {
  if (!prevSnap || !snap || prevSnap.id !== snap.id || prevSnap.index !== snap.index) return null;
  let change = null, largest = 0;
  for (const kind of ['button', 'axis']) {
    const before = kind === 'button' ? prevSnap.buttons.map((b) => b.value) : prevSnap.axes;
    const after = kind === 'button' ? snap.buttons.map((b) => b.value) : snap.axes;
    for (let index = 0; index < Math.min(before.length, after.length); index++) {
      const prev = before[index], value = after[index], delta = round(Math.abs(value - prev));
      if (delta > largest && (kind === 'button' || delta >= 0.02)) { change = { kind, index, value, prev }; largest = delta; }
    }
  }
  return change;
}

export function normalizeAxis(v, dz = DEAD_ZONE) { const a = Math.abs(v); if (a < dz) return 0; return round(Math.sign(v) * Math.min(1, (a - dz) / (1 - dz))); }

/** Radial dead zone: inside the circle the stick is at rest; outside, magnitude is rescaled so the edge of the dead zone maps to 0. */
export function normalizeStick(x, y, dz = DEAD_ZONE) {
  const mag = Math.hypot(x, y); if (mag < dz) return { x: 0, y: 0, magnitude: 0, active: false };
  const scaled = Math.min(1, (mag - dz) / (1 - dz)); const k = scaled / mag;
  return { x: round(x * k), y: round(y * k), magnitude: round(scaled), active: true };
}

/** raw snapshot → named, normalized state. Non-standard mappings yield standard:false and no named buttons. */
export function normalize(snap, dz = DEAD_ZONE) {
  if (!snap) return null;
  const standard = snap.mapping === 'standard' && snap.buttons.length >= 16 && snap.axes.length >= 4;
  const buttons = {}; if (standard) BUTTONS.forEach((n, i) => { const b = snap.buttons[i]; if (b) buttons[n] = { raw: `button[${i}]`, pressed: b.pressed, value: b.value }; });
  const sticks = standard ? { left: { raw: { x: snap.axes[0], y: snap.axes[1] }, ...normalizeStick(snap.axes[0], snap.axes[1], dz) }, right: { raw: { x: snap.axes[2], y: snap.axes[3] }, ...normalizeStick(snap.axes[2], snap.axes[3], dz) } } : null;
  const triggers = standard ? { lt: { raw: 'button[6]', value: snap.buttons[6].value, engaged: snap.buttons[6].value > TRIGGER_ON }, rt: { raw: 'button[7]', value: snap.buttons[7].value, engaged: snap.buttons[7].value > TRIGGER_ON } } : null;
  return { standard, buttons, sticks, triggers, deadZone: dz };
}

/** Digital direction of a stick with hysteresis, for navigation. prev is the previous direction (or null). */
export function stickDirection(stick, prev) {
  const { x, y, magnitude } = stick;
  if (magnitude < (prev ? STICK_NAV_OFF : STICK_NAV_ON)) return null;      // hysteresis: harder to engage than to keep
  return Math.abs(y) >= Math.abs(x) ? (y < 0 ? 'up' : 'down') : (x < 0 ? 'left' : 'right');
}

export function initialState() { return { norm: null, held: {}, stickDir: null, triggers: { lt: false, rt: false } }; }

/** One step of the input state machine. Emits named controller events for meaningful transitions only (never per frame while idle).
    Returns { state, events }. Each event: { event, raw, physical, kind, repeat?, value? }. */
export function step(state, norm, now) {
  const events = []; const s = { ...state, held: { ...state.held } };
  if (!norm || !norm.standard) { return { state: { ...initialState(), norm }, events }; }
  const prev = state.norm;
  const dir = stickDirection(norm.sticks.left, state.stickDir);
  for (const name of BUTTONS) {
    if (!norm.buttons[name]) continue;                                                            // optional button absent on this layout (e.g. no Xbox button)
    const was = !!prev?.buttons[name]?.pressed, is = !!norm.buttons[name]?.pressed; const raw = norm.buttons[name].raw;
    if (is && !was) {
      if (name === 'lt' || name === 'rt') continue;                                              // triggers are analog, handled below
      events.push(ev(`controller.${eventName(name)}`, raw, `${label(name)} pressed`, 'press'));
      if (NAV_BUTTONS.includes(name)) s.held[name] = { since: now, next: now + REPEAT_DELAY };
    } else if (!is && was) {
      if (s.held[name]) delete s.held[name];
    }
  }
  // D-pad repeat
  for (const name of NAV_BUTTONS) { const hd = s.held[name]; if (hd && now >= hd.next) { hd.next = now + REPEAT_INTERVAL; events.push(ev(`controller.nav.${name}`, norm.buttons[name].raw, `${label(name)} held ${Math.round(now - hd.since)}ms`, 'repeat', { repeat: true })); } }
  // Left stick as digital navigation with hysteresis + repeat
  if (dir !== state.stickDir) {
    if (dir) { events.push(ev(`controller.nav.${dir}`, `axes[0..1]=${norm.sticks.left.raw.x},${norm.sticks.left.raw.y}`, `left stick ${dir} (magnitude ${norm.sticks.left.magnitude})`, 'press', { source: 'stick' })); s.held['stick'] = { since: now, next: now + REPEAT_DELAY, dir }; }
    else delete s.held.stick;
    s.stickDir = dir;
  } else if (s.held.stick && now >= s.held.stick.next) { s.held.stick.next = now + REPEAT_INTERVAL; events.push(ev(`controller.nav.${dir}`, `axes[0..1]`, `left stick ${dir} held`, 'repeat', { repeat: true, source: 'stick' })); }
  // Triggers: engage / release transitions only (the analog value is read live by the scroll action)
  for (const t of ['lt', 'rt']) { const eng = norm.triggers[t].engaged; if (eng !== state.triggers[t]) { events.push(ev(`controller.${t}.${eng ? 'engage' : 'release'}`, norm.triggers[t].raw, `${t.toUpperCase()} ${eng ? 'pulled' : 'released'} (${norm.triggers[t].value})`, eng ? 'press' : 'release', { value: norm.triggers[t].value })); s.triggers = { ...s.triggers, [t]: eng }; } }
  s.norm = norm;
  return { state: s, events };
}
const ev = (event, raw, physical, kind, extra = {}) => ({ event, raw, physical, kind, ...extra });
const eventName = (b) => ({ a: 'select', b: 'back', lb: 'prevView', rb: 'nextView', view: 'inspect', menu: 'launcher', up: 'nav.up', down: 'nav.down', left: 'nav.left', right: 'nav.right' }[b] || b);
export const label = (b) => ({ a: 'A', b: 'B', x: 'X', y: 'Y', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT', view: 'View', menu: 'Menu', ls: 'L3', rs: 'R3', up: 'D-pad up', down: 'D-pad down', left: 'D-pad left', right: 'D-pad right', xbox: 'Xbox' }[b] || b);

/** The mapping table: named controller event → named Cockpit action. Everything not listed is deliberately unmapped. */
export const MAPPINGS = [
  { event: 'controller.nav.up', action: 'cockpit.selectPrev', physical: 'D-pad up · left stick up', raw: 'button[12] · axes[1] < 0', safety: 'immediate · repeats while held', what: 'move the cursor to the previous row in the current list' },
  { event: 'controller.nav.down', action: 'cockpit.selectNext', physical: 'D-pad down · left stick down', raw: 'button[13] · axes[1] > 0', safety: 'immediate · repeats while held', what: 'move the cursor to the next row in the current list' },
  { event: 'controller.nav.left', action: 'cockpit.prevTab', physical: 'D-pad left · left stick left', raw: 'button[14] · axes[0] < 0', safety: 'immediate · repeats while held', what: 'previous tab in the detail pane' },
  { event: 'controller.nav.right', action: 'cockpit.nextTab', physical: 'D-pad right · left stick right', raw: 'button[15] · axes[0] > 0', safety: 'immediate · repeats while held', what: 'next tab in the detail pane' },
  { event: 'controller.select', action: 'cockpit.activateSelected', physical: 'A', raw: 'button[0]', safety: 'immediate · press only, no repeat', what: 'click the row under the cursor (opens it)' },
  { event: 'controller.back', action: 'cockpit.back', physical: 'B', raw: 'button[1]', safety: 'immediate · press only', what: 'close the file viewer, else browser history back' },
  { event: 'controller.prevView', action: 'cockpit.prevView', physical: 'LB', raw: 'button[4]', safety: 'immediate · press only', what: 'previous view in the left rail' },
  { event: 'controller.nextView', action: 'cockpit.nextView', physical: 'RB', raw: 'button[5]', safety: 'immediate · press only', what: 'next view in the left rail' },
  { event: 'controller.lt.engage', action: 'cockpit.scrollUp', physical: 'LT (analog)', raw: 'button[6].value', safety: 'immediate · speed = trigger value', what: 'scroll the detail pane up while pulled' },
  { event: 'controller.rt.engage', action: 'cockpit.scrollDown', physical: 'RT (analog)', raw: 'button[7].value', safety: 'immediate · speed = trigger value', what: 'scroll the detail pane down while pulled' },
  { event: 'controller.inspect', action: 'cockpit.openController', physical: 'View', raw: 'button[8]', safety: 'immediate · press only', what: 'open this Controller view' },
  { event: 'controller.launcher', action: 'cockpit.openNewTask', physical: 'Menu', raw: 'button[9]', safety: 'immediate · opens a form, starts nothing', what: 'open Workflows → new task form' },
];
const byEvent = new Map(MAPPINGS.map((m) => [m.event, m]));
export function resolve(event) { return byEvent.get(event) || null; }
