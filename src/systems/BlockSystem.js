/**
 * BlockSystem — track occupancy and signal aspects (GDD §5.4 signalling).
 *
 * The whole network is treated as a set of absolute blocks, one per segment.
 * Every frame each train marks the blocks its wheels are actually on; signals
 * then read that table:
 *
 *   red      the block the signal protects is occupied
 *   yellow   the block is clear but the one beyond it is not — be ready to stop
 *   green    two clear blocks ahead
 *
 * The same table gives the AI drivers their "hold at the signal" behaviour and
 * the HUD its next-signal readout, so one source of truth drives all three.
 */
export class BlockSystem {
  constructor(net) {
    this.net = net;
    /** @type {Map<string, Set<string>>} segment id → train ids */
    this.occ = new Map();
    this._last = new Map();
  }

  /** Start a new frame: swap in a fresh table (the old one stays for queries). */
  begin() {
    this._last = this.occ;
    this.occ = new Map();
  }

  /** Mark every block a train's wheels are on. */
  mark(train) {
    if (!train || train.empty) return;
    const add = (seg) => {
      if (!seg) return;
      let set = this.occ.get(seg.id);
      if (!set) { set = new Set(); this.occ.set(seg.id, set); }
      set.add(train.id);
    };
    add(train.state?.seg);
    for (const v of train.vehicles) add(v.state?.seg);
  }

  isOccupied(segId, ignore = null) {
    const set = this.occ.get(segId);
    if (!set || set.size === 0) return false;
    if (!ignore) return true;
    for (const id of set) if (id !== ignore) return true;
    return false;
  }

  occupants(segId) { return this.occ.get(segId) || null; }

  /** The segment beyond `seg` when travelling from `fromNode` through it. */
  _beyond(seg, fromNode) {
    if (!seg) return null;
    const end = seg.endForNode(fromNode.id);
    const far = end === 'a' ? seg.nodeB : seg.nodeA;
    if (!far) return null;
    const br = far.branches?.[Math.max(0, far.active | 0)];
    return br?.segment || null;
  }

  /**
   * Predicate for StructureManager.updateSignals.
   * @returns {boolean|'caution'} true = danger, 'caution' = proceed to the next signal only
   */
  occupied(node, seg) {
    if (!node || !seg) return false;
    if (this.isOccupied(seg.id)) return true;
    const beyond = this._beyond(seg, node);
    if (beyond && this.isOccupied(beyond.id)) return 'caution';
    return false;
  }

  /** Aspect a driver sees on the approach to `node` from `seg`, as a string. */
  aspectAt(node, seg) {
    const o = this.occupied(node, seg);
    return o === true ? 'red' : o === 'caution' ? 'yellow' : 'green';
  }

  /**
   * Is there a train within `dist` metres along the route from `state`?
   * Used by AI drivers to keep their distance.
   */
  trainAhead(state, dist = 500, ignore = null) {
    const probe = this.net.cloneState(state);
    let travelled = 0;
    const seen = new Set();
    while (travelled < dist) {
      const step = Math.min(20, dist - travelled);
      const moved = this.net.advance(probe, step);
      travelled += moved;
      if (probe.blocked) return { blocked: true, distance: travelled, reason: probe.blocked };
      const seg = probe.seg;
      if (seg && !seen.has(seg.id)) {
        seen.add(seg.id);
        if (this.isOccupied(seg.id, ignore)) {
          const others = [...this.occ.get(seg.id)].filter((id) => id !== ignore);
          return { blocked: true, distance: travelled, trains: others, seg: seg.id };
        }
      }
      if (moved < step - 1e-6) break;
    }
    return null;
  }

  /** Aspect for the signal protecting the next node along a train's route. */
  nextAspect(train, maxDist = 900) {
    if (!train.state) return null;
    const look = this.net.scanAhead(train.state, maxDist, 25);
    for (const f of look) {
      if ((f.type === 'junction' || f.type === 'node' || f.type === 'station') && f.node?.switchable) {
        const chosen = f.node.branches[Math.max(0, f.node.active | 0)]?.segment;
        if (!chosen) continue;
        return { distance: f.distance, node: f.node.id, aspect: this.aspectAt(f.node, chosen), seg: chosen.id };
      }
      if (f.type === 'buffer') return { distance: f.distance, node: f.node?.id || null, aspect: 'red', buffer: true };
    }
    return null;
  }

  serialize() { return null; }
  clear() { this.occ.clear(); this._last.clear(); }
}

export default BlockSystem;
