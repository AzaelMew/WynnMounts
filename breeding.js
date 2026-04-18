// ─── Multi-Gen Breeding DP (ported from math.py) ──────────────────────────────

import { MATERIALS } from './data.js';

// Build tier→best-points lookup from MATERIALS (sorted desc by tier for fast lookup)
const TIER_BEST_POINTS = (() => {
  const map = new Map();
  for (const [tier, , ...stats] of MATERIALS) {
    const pts = stats.reduce((a, b) => a + b, 0);
    if (!map.has(tier) || pts > map.get(tier)) map.set(tier, pts);
  }
  return [...map.entries()].sort((a, b) => b[0] - a[0]);
})();

export function getBestPoints(level) {
  for (const [t, p] of TIER_BEST_POINTS) if (level >= t) return p;
  return 12;
}

export function breedFeedCostGen0(targetLim) {
  // Each feed takes 6h flat (same as a breed). Count feeds needed, multiply by 6.
  let sum = 80; // 8 stats × base limit 10
  const target = targetLim * 8;
  let feeds = 0;
  const ptsPerFeed = getBestPoints(30); // Gen 0 horses cap at lvl 30
  while (sum < target) {
    sum += ptsPerFeed;
    feeds++;
  }
  return feeds * 6;
}

export function breedFeedCostGenN(startLim, targetLim, level) {
  if (targetLim <= startLim) return 0;
  return Math.ceil((targetLim - startLim) * 8 / getBestPoints(level)) * 6;
}

export function breedFeedsGenN(startLim, targetLim, level) {
  if (targetLim <= startLim) return 0;
  return Math.ceil((targetLim - startLim) * 8 / getBestPoints(level));
}

// assumeTraining=true → use M_prev as feed level (player trains horse to max before feeding)
// assumeTraining=false → use fallbackLevel (actual cur levels entered by user)
export function computeBreedingDP(assumeTraining, fallbackLevel) {
  const dp = Array.from({length: 35}, () => ({}));

  // Base case: Gen 1 from two Gen 0 parents (base limit 10, fed to L0)
  for (let L0 = 20; L0 <= 30; L0++) {
    const M1 = L0 + 30;
    const cost = 2 * breedFeedCostGen0(L0) + 6;
    if (!dp[1][M1] || cost < dp[1][M1].cost)
      dp[1][M1] = { cost, M_prev: 10, L0 };
  }

  // Transitions: Gen 2–N
  for (let gen = 2; gen <= 30; gen++) {
    for (const [Ms, entry] of Object.entries(dp[gen - 1])) {
      const M_prev = +Ms;
      const base = M_prev - 20;
      if (base < 1) continue;
      const lvl = assumeTraining ? M_prev : fallbackLevel;
      for (let L = base; L <= M_prev; L++) {
        const M_curr = L + 30;
        const cost = 2 * (entry.cost + breedFeedCostGenN(base, L, lvl)) + 6;
        if (!dp[gen][M_curr] || cost < dp[gen][M_curr].cost)
          dp[gen][M_curr] = { cost, M_prev };
      }
    }
  }
  return dp;
}

export function findBestDP(dp, targetPot) {
  const need = Math.ceil(targetPot / 8);
  let best = null;
  for (let g = 1; g <= 30; g++)
    for (const [Ms, e] of Object.entries(dp[g]))
      if (+Ms >= need && (!best || e.cost < dp[best.gen][best.M].cost))
        best = { gen: g, M: +Ms };
  return best;
}

export function traceBreedPath(dp, best) {
  const steps = [];
  let g = best.gen, M = best.M;
  while (g >= 2) {
    const e = dp[g][M];
    const L_prev = M - 30;
    const base = e.M_prev - 20;
    steps.unshift({ gen: g, M_curr: M, L_prev, base, M_prev: e.M_prev });
    g--; M = e.M_prev;
  }
  // Gen 1 base step
  const e1 = dp[1][M];
  steps.unshift({ gen: 1, M_curr: M, L_prev: e1.L0, base: 10, M_prev: 10, isGen1: true });
  return steps;
}

export function fmtH(h) {
  if (h < 1) return Math.round(h * 60) + 'm';
  if (h < 24) return h.toFixed(1) + 'h';
  const d = Math.floor(h / 24), r = Math.round(h % 24);
  return r ? `${d}d ${r}h` : `${d}d`;
}
