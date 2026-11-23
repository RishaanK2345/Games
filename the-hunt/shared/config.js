// Balance numbers and round settings
// Shared between the browser client and the game server. No DOM, no three.js in here.

export const CONFIG = {
  roundTime: 180,          // set from map size each round: small 2:00, medium 3:00, large 4:00
  freezeTime: 15,          // monster frozen at start
  cells: 16,               // map is cells x cells
  cellSize: 4,             // meters per cell (corridor width)
  wallHeight: 3,
  wallThick: 0.2,
  loopChance: 0.16,        // extra wall removals that create circuits
  braidChance: 0.6,        // chance to open up each dead end
  rooms: 4,                // big open rooms with pillars
  pillarChance: 0.55,
  lightChance: 0.7,        // fraction of cells with a ceiling panel
  deadLightChance: 0.1,
  entityFlickerRadius: 14, // lights within this distance of the Entity go haywire
  flickerChance: 0.1,
  walkSpeed: 3.2,
  sprintSpeed: 5.9,
  crouchSpeed: 1.6,
  monsterSpeed: 4.65,       // between walk and sprint
  entityBurstSpeed: 8,   // Entity burst: much faster than a sprinting survivor
  entityBurstTime: 3,
  entityBurstCooldown: 12.5, // starts when the burst ends
  mimicCooldown: 13,
  mimicSpeed: 3.7,         // disguised walking speed: a bit faster than a walking survivor, well under their sprint       // Mimic: time before it can disguise again after unveiling
  revealTime: 0.55,        // unveiling takes this long; no attacks until it's done
  sprintTime: 10,          // seconds of sprint on a full bar
  exhaustCooldown: 6.5,      // if the bar hits zero: no sprinting for this long (bar refills during it)
  staminaRegen: 1/7,       // normal refill rate when not sprinting
  biteRange: 1.5,          // [1] bite: same reach as the old attack
  biteCooldown: 1.0,
  swipeRange: 2.45,         // [2] arm swipe: longer reach, wide arc
  swipeCooldown: 3,
  catchRecover: 1.5,       // Entity is slowed briefly after catching someone
  hearSprint: 20,
  hearWalk: 7,
  visionRange: 30,
  visionFov: 110,          // degrees
  survivors: 5,
  leanSurvivor: 0.45,      // how far you can lean out (m), limited by walls
  leanEntity: 0.6,
  entityCrouchSpeed: 0.55, // Entity speed multiplier while crouched
  ventDensity: 0.025,      // vents per cell (16x16 map = ~6 vents)
  ripCooldown: 20,         // Entity: rip a vent open (E)
  ripRoot: 1.0,            // Entity is stuck in place while ripping
  ripEjectDelay: 0.45,     // hider gets thrown out this long after the rip starts
  ripAttackLock: 1.4,      // Entity can't bite/swipe this long after ripping (head start for the hider)
  longHalls: 2,            // long straight Level 0 hallways cut through the maze
  darkWings: 1,            // big regions where the lights never worked
  wetDensity: 0.08,        // fraction of the map that's soaked carpet (loud footsteps)
  fogFar: 25,
  corruptTime: 120,
  redTime: 30,             // last N seconds: every light turns red
  lateVentTime: 5,         // ...and in those last N seconds each survivor gets only this much vent time in total
  blackoutMin: 25,         // seconds between regional blackouts (random in range)
  blackoutMax: 45,
  blackoutRadius: 2.5,     // in cells (~10 m across)
  blackoutDur: [8,12],     // seconds the region stays dark
  darkVision: 6,           // how far anyone (bots included) can see inside a blackout        // seconds for a body to be fully overrun by parasites
  ventWarn: 15,            // seconds in a vent: first insanity warning
  ventSmilers: 20,         // smilers start showing
  ventDeath: 25,           // smilers get you
  sanityRecover: 1,        // sanity time drained per second once you're out
};

// untouched copy, restored at the start of every round (anomalies modify CONFIG)
export const BASE_CONFIG=JSON.parse(JSON.stringify(CONFIG));

export const ROUND_TIME={12:120,16:180,20:240};   // round length follows map size

export function resetConfig(size){ Object.assign(CONFIG,JSON.parse(JSON.stringify(BASE_CONFIG))); CONFIG.cells=size; CONFIG.roundTime=ROUND_TIME[size]||180; }
