// ─── Breeding Estimator (ported from ReverseMounts Python simulator) ───────────

import { STATS } from './data.js';

// Internal keys matching the Python model naming
const EST_KEYS = [
  'speed', 'accel', 'altitude', 'energy_stat',
  'handling', 'toughness', 'boost', 'training',
];

export { EST_KEYS };

// ─── Random helpers ───────────────────────────────────────────────────────────

// Box-Muller transform
function randNormal(mean, std) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + std * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function simValBonus() {
  while (true) {
    const v = Math.round(randNormal(0.6, 2.1));
    if (v >= -13 && v <= 6) return v;
  }
}

function simLimBonus() {
  while (true) {
    const v = Math.round(randNormal(9.7, 3.4));
    if (v >= -1 && v <= 20) return v;
  }
}

function simMaxBonus() {
  while (true) {
    const v = Math.round(randNormal(29.0, 11.0));
    if (v >= 5 && v <= 69) return v;
  }
}

function simEnergyMaxBonus() {
  while (true) {
    const v = Math.round(randNormal(1.0, 2.6));
    if (v >= 0 && v <= 13) return v;
  }
}

function simEnergyValueDiff() {
  while (true) {
    const v = Math.round(randNormal(0.0, 25.0));
    if (v >= -120 && v <= 20) return v;
  }
}

// ─── Core simulation ──────────────────────────────────────────────────────────

/**
 * Simulate a single offspring from two parents.
 *
 * Parent objects must contain flat keys:
 *   speed_val, speed_lim, speed_max,
 *   accel_val, accel_lim, accel_max, …
 *   energy_value, energy_max
 */
export function simulateOffspring(parentA, parentB) {
  const off = {};

  for (let i = 0; i < EST_KEYS.length; i++) {
    const key = EST_KEYS[i];

    const aVal = parentA[`${key}_val`];
    const bVal = parentB[`${key}_val`];
    const aLim = parentA[`${key}_lim`];
    const bLim = parentB[`${key}_lim`];

    // val ~ max(parent vals) + variance
    let val = Math.max(aVal, bVal) + simValBonus();

    // lim ~ avg(parent lims) + bonus
    const avgLim = (aLim + bLim) / 2.0;
    const lim = Math.round(avgLim) + simLimBonus();

    // max ~ avg(parent lims) + big bonus (must be >= lim)
    let max = Math.round(avgLim) + simMaxBonus();
    max = Math.max(max, lim);

    // Clamp val
    val = Math.max(0, Math.min(val, max));

    off[`${key}_val`] = val;
    off[`${key}_lim`] = lim;
    off[`${key}_max`] = max;
  }

  // Energy bar
  const energyMax = Math.max(parentA.energy_max, parentB.energy_max) + simEnergyMaxBonus();
  const avgEnergyValue = (parentA.energy_value + parentB.energy_value) / 2.0;
  let energyValue = Math.round(avgEnergyValue) + simEnergyValueDiff();
  energyValue = Math.max(0, Math.min(energyValue, energyMax));

  off.energy_max = energyMax;
  off.energy_value = energyValue;

  // Potential == sum of all 8 stat maxes
  let potential = 0;
  for (let i = 0; i < EST_KEYS.length; i++) {
    potential += off[`${EST_KEYS[i]}_max`];
  }
  off.potential = potential;

  return off;
}

/**
 * Run N simulations and collect per-field distributions.
 * @returns {Object}  field name → array of values
 */
export function simulateMany(parentA, parentB, runs = 5000) {
  const results = { potential: [] };
  for (let i = 0; i < EST_KEYS.length; i++) {
    const key = EST_KEYS[i];
    results[`${key}_val`] = [];
    results[`${key}_lim`] = [];
    results[`${key}_max`] = [];
  }
  results.energy_max = [];
  results.energy_value = [];

  for (let r = 0; r < runs; r++) {
    const off = simulateOffspring(parentA, parentB);
    results.potential.push(off.potential);
    for (let i = 0; i < EST_KEYS.length; i++) {
      const key = EST_KEYS[i];
      results[`${key}_val`].push(off[`${key}_val`]);
      results[`${key}_lim`].push(off[`${key}_lim`]);
      results[`${key}_max`].push(off[`${key}_max`]);
    }
    results.energy_max.push(off.energy_max);
    results.energy_value.push(off.energy_value);
  }

  return results;
}

// ─── Statistics ───────────────────────────────────────────────────────────────

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr) {
  const m = mean(arr);
  const variance = arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

export function summarizeDistribution(values) {
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    mean: Math.round(mean(values)),
    sd: parseFloat(stdDev(values).toFixed(1)),
  };
}
