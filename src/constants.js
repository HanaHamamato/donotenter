/**
 * IRONBOUND — global tuning constants.
 * Everything gameplay-affecting lives here so phases can be balanced without
 * touching system code (GDD §1.1, §3.5, §5).
 */

export const VERSION = '1.0.0';
export const SAVE_VERSION = 3;

/* ------------------------------------------------------------------ world */
export const WORLD = {
  size: 16000, // 16 km × 16 km playable area (GDD §2.1)
  half: 8000,
  chunkSize: 2000, // 8×8 = 64 chunks
  chunksPerSide: 8,
  seaLevel: 0,
  gravity: 9.80665,
};

/** Chunk LOD rings (GDD §5.2.3). Radius is in chunks from the player chunk. */
export const CHUNK_LOD = [
  { radius: 1, resolution: 128 }, // LOD0 — full detail
  { radius: 2, resolution: 64 }, //  LOD1
  { radius: 3, resolution: 32 }, //  LOD2
  { radius: 4, resolution: 16 }, //  LOD3
];
export const STREAM_RADIUS = 4; // load a 9×9 window, draw LOD4 horizon filler beyond
export const VEGETATION_RADIUS = 1600; // metres — beyond this, terrain tint only

/* ---------------------------------------------------------------- physics */
export const PHYS = {
  gravity: WORLD.gravity,
  fixedStep: 1 / 60, // 60 Hz simulation (GDD §5.2.2)
  maxSubSteps: 5,

  // Tractive effort: TE = min(TE_adhesion, P / v)
  adhesionCoeff: 0.25, // dry rail, steel on steel
  adhesionWeather: { clear: 1.0, cloudy: 0.98, rain: 0.74, storm: 0.62, snow: 0.55, fog: 0.95 },

  // Service braking deceleration at 100% (a = mu * g)
  brakeCoeff: 0.055,
  emergencyBrakeMul: 1.45,
  handBrakeDecel: 0.02,

  // Davis-style resistance, expressed as deceleration [m/s^2]
  rollA: 0.00085,
  rollB: 0.000042,
  rollC: 0.0000046,
  curveResistCoeff: 0.011, // F_curve = m v^2 / R * f

  // Air brake propagation: seconds per car (front → rear)
  brakePipePerCar: 0.11,
  brakePipeBase: 0.45,
  brakeReleasePerCar: 0.08,

  minSpeedForPower: 0.6, // m/s — below this, TE is clamped (avoids div-by-zero)
  coupleMaxSpeed: 1.6, // m/s (~5.7 km/h) — GDD §1.1 coupling rule
  coupleReach: 6.0, // metres
  derailSpeedFactor: 1.28, // v > limit * factor → derailment
  derailCurveFactor: 1.55, // unbalanced lateral accel tolerance
  maxLateralAccel: 1.35, // m/s^2 before the wheels climb the rail
  bufferStopSpeed: 0.05,
};

export const GAUGE = 1.435; // standard gauge, metres
export const TIE_SPACING = 0.62;
export const CAR_GAP = 1.1; // coupler slack between cars

/* --------------------------------------------------------------- rolling stock */
export const CAR_TYPES = {
  locomotive: { label: 'Locomotive', length: 18, massEmpty: 100000, massLoaded: 100000, color: 0x2f4f6f },
  boxcar: { label: 'Boxcar', length: 15, massEmpty: 26000, massLoaded: 96000, color: 0x8a5a34, freight: true },
  hopper: { label: 'Hopper', length: 13, massEmpty: 24000, massLoaded: 100000, color: 0x6b6f73, freight: true },
  tanker: { label: 'Tanker', length: 14, massEmpty: 25000, massLoaded: 92000, color: 0x9aa4a8, freight: true },
  flatbed: { label: 'Flatbed', length: 16, massEmpty: 22000, massLoaded: 84000, color: 0x57606a, freight: true },
  gondola: { label: 'Gondola', length: 14, massEmpty: 25000, massLoaded: 98000, color: 0x704b3a, freight: true },
  coach: { label: 'Passenger Coach', length: 21, massEmpty: 42000, massLoaded: 62000, color: 0x3d6b52, passenger: true },
  caboose: { label: 'Caboose', length: 10, massEmpty: 18000, massLoaded: 18000, color: 0x9c3b2e },
};

/** Locomotive catalogue (GDD §3.5). */
export const LOCOMOTIVES = {
  gp7: {
    id: 'gp7', bodyLength: 17, name: 'GP-7 Workhorse', cost: 0, unlock: 'start',
    maxSpeed: 80, maxCars: 4, mass: 100000, powerHP: 1500, teStart: 245000,
    color: 0x2f5d7c, accent: 0xd8b23a, desc: 'A reliable four-axle road switcher. Slow, but it never quits.',
  },
  sd40: {
    id: 'sd40', bodyLength: 21, name: 'SD-40 Freight', cost: 2000, unlock: 'trusted',
    maxSpeed: 100, maxCars: 6, mass: 170000, powerHP: 3000, teStart: 400000,
    color: 0x7a3b2e, accent: 0xe8d9b0, desc: 'Six axles of freight muscle. The backbone of any tonnage haul.',
  },
  funit: {
    id: 'funit', bodyLength: 15.5, name: 'F-Unit Passenger', cost: 3500, unlock: 'express',
    maxSpeed: 120, maxCars: 4, mass: 110000, powerHP: 2250, teStart: 265000,
    color: 0xb4462f, accent: 0xf0e6d2, desc: 'Streamlined and fast. Built for coaches, not for coal.',
  },
  ac9: {
    id: 'ac9', bodyLength: 24, name: 'AC-9 Mountain King', cost: 10000, unlock: 'baron',
    maxSpeed: 90, maxCars: 8, mass: 250000, powerHP: 4500, teStart: 610000,
    color: 0x2b3a2f, accent: 0xc8a44a, desc: 'Articulated helper service. It will pull the mountain itself.',
  },
};

/* ------------------------------------------------------------------- cargo */
export const CARGO = {
  timber: { label: 'Timber', car: 'flatbed', color: 0x9c6b3f, fragile: false, unitValue: 120 },
  coal: { label: 'Coal', car: 'hopper', color: 0x2c2c30, fragile: false, unitValue: 90 },
  ironore: { label: 'Iron Ore', car: 'gondola', color: 0x8a5f4b, fragile: false, unitValue: 150 },
  grain: { label: 'Grain', car: 'hopper', color: 0xd9b45b, fragile: false, unitValue: 100 },
  steel: { label: 'Steel', car: 'flatbed', color: 0x9fb0bd, fragile: false, unitValue: 260 },
  parts: { label: 'Machine Parts', car: 'boxcar', color: 0x6f7d8a, fragile: true, unitValue: 340 },
  goods: { label: 'Goods', car: 'boxcar', color: 0x7d6a4f, fragile: true, unitValue: 210 },
  food: { label: 'Food', car: 'boxcar', color: 0x8fa35c, fragile: true, unitValue: 180 },
  fish: { label: 'Fish', car: 'boxcar', color: 0x6d8f9c, fragile: true, unitValue: 200 },
  fertilizer: { label: 'Fertilizer', car: 'tanker', color: 0xa89b6a, fragile: false, unitValue: 130 },
  livestock: { label: 'Livestock', car: 'gondola', color: 0xa5836a, fragile: true, unitValue: 175 },
  supplies: { label: 'Supplies', car: 'boxcar', color: 0x77889a, fragile: false, unitValue: 160 },
  passengers: { label: 'Passengers', car: 'coach', color: 0x4a7a63, fragile: true, unitValue: 300, passenger: true },
};

/* --------------------------------------------------------------- biomes */
export const BIOMES = {
  alpine: {
    id: 'alpine', label: 'Alpine', fogColor: 0xb9c9d8, fogDensity: 0.00042,
    ambient: 0x9fb6cc, ground: 0x7c7f74, treeDensity: 0.16, treeTypes: ['conifer', 'dead'],
    snowLine: 330, rockiness: 0.75,
  },
  forest: {
    id: 'forest', label: 'Temperate Forest', fogColor: 0xc3d4bd, fogDensity: 0.00034,
    ambient: 0xa9c39a, ground: 0x4f6b3a, treeDensity: 0.62, treeTypes: ['conifer', 'deciduous'],
    snowLine: 9999, rockiness: 0.28,
  },
  plains: {
    id: 'plains', label: 'Plains & Farmland', fogColor: 0xded3ae, fogDensity: 0.00028,
    ambient: 0xd8cf9f, ground: 0x9a9451, treeDensity: 0.05, treeTypes: ['deciduous'],
    snowLine: 9999, rockiness: 0.08,
  },
  coastal: {
    id: 'coastal', label: 'Coastal Wetland', fogColor: 0xbccad2, fogDensity: 0.00045,
    ambient: 0x9fbcc4, ground: 0x5f7350, treeDensity: 0.14, treeTypes: ['dead', 'deciduous'],
    snowLine: 9999, rockiness: 0.1,
  },
};

export const REGION_OF_BIOME = { alpine: 'alpine', forest: 'forest', plains: 'plains', coastal: 'coastal' };

/* --------------------------------------------------------------- economy */
export const ECONOMY = {
  startCredits: 500,
  contractInterval: 5 * 60, // game-seconds between contract rolls (GDD §3.2)
  maxContractsPerStation: 4,
  minContractsPerStation: 2,
  payPerKm: 26,
  payPerCar: 85,
  timeBonusFactor: 0.35,
  conditionBonusFactor: 0.2,
  fragilePremium: 1.35,
  repairCostPerPoint: 12,
  derailPenalty: 350,
  timeScale: 6, // game minutes per real minute
  dayLengthMinutes: 20, // full day/night cycle in REAL minutes (GDD §4.1)
};

/* ----------------------------------------------------------- progression */
export const MILESTONES = [
  { id: 'newcomer', name: 'Newcomer', desc: 'Starter loco, Plains region unlocked.', check: () => true },
  { id: 'licensed', name: 'Licensed', desc: '5 deliveries — Forest region unlocked.', check: (s) => s.deliveries >= 5, unlockRegion: 'forest' },
  { id: 'trusted', name: 'Trusted', desc: '$2,000 earned — SD-40 Freight available.', check: (s) => s.earned >= 2000, unlockLoco: 'sd40' },
  { id: 'harbormaster', name: 'Harbormaster', desc: 'Rep 3 at Millford — Coastal region unlocked.', check: (s) => (s.rep.millford || 0) >= 3, unlockRegion: 'coastal' },
  { id: 'ironworker', name: 'Ironworker', desc: 'Rep 3 at Ironvale — Alpine region unlocked.', check: (s) => (s.rep.ironvale || 0) >= 3, unlockRegion: 'alpine' },
  { id: 'express', name: 'Express Driver', desc: '10 timed deliveries with bonus — passenger running.', check: (s) => s.timedBonuses >= 10, unlockLoco: 'funit', unlockPassengers: true },
  { id: 'baron', name: 'Rail Baron', desc: '$10,000 + Rep 5 at three stations — AC-9 Mountain King.', check: (s) => s.earned >= 10000 && Object.values(s.rep).filter((v) => v >= 5).length >= 3, unlockLoco: 'ac9', unlockStation: 'oldredstone' },
  { id: 'legend', name: 'Legend', desc: 'Rep 5 everywhere — Summit Loop opens, golden livery.', check: (s) => s.repStations >= 10 && Object.values(s.rep).filter((v) => v >= 5).length >= 8, unlockBranch: 'summitloop' },
];

export const UPGRADES = {
  brakes: {
    label: 'Brake Rigging', max: 3, costs: [400, 900, 1800],
    desc: ['+', '++', '+++'].map((_, i) => `Tier ${i + 1}: faster application, +${(i + 1) * 8}% braking force`),
  },
  engine: {
    label: 'Engine Tuning', max: 3, costs: [550, 1200, 2400],
    desc: [0, 1, 2].map((i) => `Tier ${i + 1}: +${(i + 1) * 15}% tractive effort`),
  },
  capacity: {
    label: 'Coupler Capacity', max: 3, costs: [350, 800, 1600],
    desc: [0, 1, 2].map((i) => `Tier ${i + 1}: +${i + 1} max coupled car`),
  },
};

/* ----------------------------------------------------------------- input */
export const KEYBINDS = {
  throttleUp: ['KeyW', 'ArrowUp'],
  throttleDown: ['KeyS', 'ArrowDown'],
  brake: ['Space'],
  emergency: ['KeyB'],
  reverse: ['KeyR'],
  junction: ['Tab'],
  horn: ['KeyH'],
  camera: ['KeyC'],
  map: ['KeyM'],
  interact: ['KeyE'],
  headlight: ['KeyF'],
  pause: ['Escape'],
  photo: ['KeyP'],
  decouple: ['KeyQ'],
  decoupleLast: ['ShiftLeft+KeyQ'],
  dynamic: ['KeyX'],
  sander: ['KeyZ'],
  bell: ['KeyL'],
  career: ['KeyJ'],
  shop: ['KeyU'],
  consist: ['KeyT'],
  rerail: ['KeyG'],
  freeLook: ['KeyV'],
  save: ['F5'],
  load: ['F9'],
  cam1: ['Digit1'], cam2: ['Digit2'], cam3: ['Digit3'], cam4: ['Digit4'],
  cam5: ['Digit5'],
  debug: ['F3'],
};

/* -------------------------------------------------------------- rendering */
export const RENDER = {
  fov: 60,
  fovSpeedBoost: 10,
  near: 0.4,
  far: 22000,
  shadowMapSize: 2048,
  cascades: 3,
  presets: {
    low: { shadows: false, shadowMapSize: 1024, post: false, vegetation: 0.5, lodBias: 2, drawDistance: 2500, waterDetail: 0 },
    medium: { shadows: true, shadowMapSize: 2048, post: true, bloom: true, ssao: false, vegetation: 1.0, lodBias: 1, drawDistance: 6000, waterDetail: 1 },
    high: { shadows: true, shadowMapSize: 4096, post: true, bloom: true, ssao: true, vegetation: 1.6, lodBias: 0, drawDistance: 12000, waterDetail: 2 },
  },
};

export const COLORS = {
  rail: 0x8f8b84,
  tie: 0x4a382a,
  ballast: 0x6d6659,
  player: 0x2f5d7c,
  ai: 0xc9a227,
};
