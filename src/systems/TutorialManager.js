/**
 * TutorialManager — the first hour, taught (GDD §9 onboarding).
 *
 * A linear script of small lessons, each with a condition that is checked
 * against the live game state. Nothing is modal: the player can drive straight
 * past a lesson and it will wait. The card in the corner shows the current
 * objective and the control that gets you there, and once the last lesson is
 * done the tutorial steps out of the way for good.
 */
import { bus } from '../utils/events.js';

export const TUTORIAL_STEPS = [
  {
    id: 'throttle', title: 'Open the throttle',
    text: 'Press W to notch up. Eight notches, one at a time.',
    hint: 'W — throttle up · S — throttle down',
    check: (c) => c.train?.controls.throttle > 0,
  },
  {
    id: 'rolling', title: 'Get rolling',
    text: 'A loaded train takes a moment. Hold a notch until you reach 25 km/h.',
    hint: 'Watch the speed readout, bottom left',
    check: (c) => (c.train?.kmh || 0) >= 25,
  },
  {
    id: 'brake', title: 'Air brake',
    text: 'Hold Space to apply the brake. It travels front to rear, car by car.',
    hint: 'Space — brake · B — emergency',
    check: (c) => c.flags.braked && (c.train?.kmh || 0) < 12,
  },
  {
    id: 'camera', title: 'Look around',
    text: 'Press C to change camera. Try the cab view and look out of the window.',
    hint: 'C — cycle camera · 1-5 — direct select',
    check: (c) => c.flags.cameraChanged,
  },
  {
    id: 'station', title: 'Stop at a station',
    text: 'Bring the locomotive to a platform road and stop. Any station will do.',
    hint: 'Ease off the brake early — the pipe takes a second',
    check: (c) => !!c.station && c.train?.kmh < 0.6,
  },
  {
    id: 'board', title: 'Read the contract board',
    text: 'At the station, open the board (E) and see what work is on offer.',
    hint: 'E — interact / open the station panel',
    check: (c) => c.flags.openedBoard,
  },
  {
    id: 'contract', title: 'Take a contract',
    text: 'Accept a run you can reach before the deadline.',
    hint: 'Deadlines are in work hours, printed on the card',
    check: (c) => c.flags.contractAccepted,
  },
  {
    id: 'load', title: 'Load your cars',
    text: 'With compatible empty cars in the consist, loading is automatic when you accept. Otherwise shunt the right cars to the platform.',
    hint: 'Q — uncouple · couple by driving gently into a car',
    check: (c) => c.flags.loaded,
  },
  {
    id: 'junction', title: 'Throw a switch',
    text: 'Approach a junction and press Tab to set the route. The signal will tell you what it is set for.',
    hint: 'Tab — cycle the route ahead',
    check: (c) => c.flags.junctionCycled,
  },
  {
    id: 'deliver', title: 'Deliver',
    text: 'Run your load to the destination station and stop. The cargo sells itself.',
    hint: 'Arrive early for the time bonus',
    check: (c) => c.flags.contractComplete,
  },
  {
    id: 'map', title: 'The map',
    text: 'Press M for the network map. It shows your train, contracts and the regions still closed to you.',
    hint: 'M — map · F3 — debug overlay',
    check: (c) => c.flags.mapOpened,
  },
  {
    id: 'done', title: 'You are a railroader',
    text: 'That is everything. Build reputation, unlock regions, and buy better iron. The Summit Loop is waiting.',
    hint: '',
    check: () => false,
    terminal: true,
  },
];

export class TutorialManager {
  constructor(deps = {}) {
    this.deps = deps;
    this.steps = TUTORIAL_STEPS;
    this.index = deps.index ?? 0;
    this.enabled = deps.enabled !== false;
    this.flags = {
      braked: false, cameraChanged: false, openedBoard: false, contractAccepted: false,
      loaded: false, junctionCycled: false, contractComplete: false, mapOpened: false,
    };
    this.completedAt = null;
    this.holdTimer = 0;
    this.message = null;

    this._unsubs = [
      bus.on('train:brakeApplied', () => { this.flags.braked = true; }),
      bus.on('camera:mode', () => { this.flags.cameraChanged = true; }),
      bus.on('ui:panel', (e) => {
        if (e.id === 'station' || e.id === 'board') this.flags.openedBoard = true;
        if (e.id === 'map') this.flags.mapOpened = true;
      }),
      bus.on('contract:accepted', () => { this.flags.contractAccepted = true; }),
      bus.on('contract:loaded', () => { this.flags.loaded = true; }),
      bus.on('contract:complete', () => { this.flags.contractComplete = true; }),
      bus.on('junction:cycle', () => { this.flags.junctionCycled = true; }),
      bus.on('train:emergency', () => { this.flags.braked = true; }),
    ];
  }

  get step() { return this.steps[Math.min(this.index, this.steps.length - 1)]; }
  get finished() { return this.index >= this.steps.length - 1 && !!this.completedAt; }

  /** Live context the checks are evaluated against. */
  context() {
    const d = this.deps;
    return {
      train: d.train?.() || d.train || null,
      station: d.station?.() || null,
      economy: d.economy?.() || null,
      contracts: d.contracts?.() || null,
      flags: this.flags,
    };
  }

  update(dt) {
    if (!this.enabled || this.finished) return;
    const step = this.step;
    if (!step) return;
    if (step.terminal) {
      this.holdTimer += dt;
      if (this.holdTimer > 12) { this.completedAt = Date.now(); bus.emit('tutorial:complete', {}); }
      return;
    }
    let ok = false;
    try { ok = !!step.check(this.context()); } catch (err) { ok = false; }
    if (ok) {
      this.index++;
      this.holdTimer = 0;
      const next = this.step;
      bus.emit('tutorial:step', { index: this.index, step: next, done: step.id });
      if (next && !next.terminal) {
        bus.emit('notify', { kind: 'good', title: `Next: ${next.title}`, text: next.text, ttl: 8 });
      }
    }
  }

  skip() {
    this.index = this.steps.length - 1;
    this.completedAt = Date.now();
    this.enabled = false;
    bus.emit('tutorial:skipped', {});
  }

  reset() {
    this.index = 0;
    this.completedAt = null;
    this.enabled = true;
    this.holdTimer = 0;
    for (const k of Object.keys(this.flags)) this.flags[k] = false;
  }

  serialize() {
    return { index: this.index, enabled: this.enabled, flags: { ...this.flags }, completedAt: this.completedAt };
  }

  restore(d) {
    if (!d) return;
    this.index = d.index ?? 0;
    this.enabled = d.enabled !== false;
    this.flags = { ...this.flags, ...(d.flags || {}) };
    this.completedAt = d.completedAt || null;
  }

  dispose() { for (const off of this._unsubs) off(); this._unsubs = []; }
}

export default TutorialManager;
