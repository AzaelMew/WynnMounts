import { MATERIALS, STATS, TIER_THRESHOLDS } from './data.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function maxUsableTier(H) {
  return TIER_THRESHOLDS.reduce((best, t) => t <= H ? t : best, -1);
}

function dominates(a, b) {
  let strictlyBetter = false;
  for (let s = 0; s < 8; s++) {
    const av = a[2 + s] || 0;
    const bv = b[2 + s] || 0;
    if (av < bv) return false;
    if (av > bv) strictlyBetter = true;
  }
  return strictlyBetter;
}

export function candsSorted(tier) {
  const pool = MATERIALS.filter(m => m[0] <= tier);
  const pruned = pool.filter((mat, idx) => {
    for (let i = 0; i < pool.length; i++) {
      if (i !== idx && dominates(pool[i], mat)) return false;
    }
    return true;
  });

  return pruned.sort(
    (a, b) => b.slice(2).reduce((t, v) => t + v, 0) - a.slice(2).reduce((t, v) => t + v, 0),
  );
}

// ─── LP relaxation solver (Big-M simplex) ────────────────────────────────────
// minimize Σx_i  s.t.  A·x ≥ b,  x ≥ 0
export function solveLP(cands, solvable, nc) {
  const active = [];
  for (let s = 0; s < 8; s++) if (solvable[s] > 0) active.push(s);
  const m = active.length;
  if (m === 0) return new Array(nc).fill(0);

  // x[0..nc-1]  surplus[0..m-1]  artificial[0..m-1]
  const nv = nc + 2 * m;
  const BIG_M = 1e9;
  const tab = Array.from({length: m + 1}, () => new Float64Array(nv + 1));

  for (let i = 0; i < m; i++) {
    const s = active[i];
    for (let j = 0; j < nc; j++) tab[i][j] = cands[j][2 + s] || 0;
    tab[i][nc + i]     = -1; // surplus
    tab[i][nc + m + i] =  1; // artificial
    tab[i][nv]         = solvable[s];
  }
  // MIN objective: 1 per material, BIG_M per artificial, 0 for surplus.
  for (let j = 0; j < nc; j++) tab[m][j] = 1;
  for (let i = 0; i < m; i++) tab[m][nc + m + i] = BIG_M;
  // Adjust for initial artificial basis (c_B = BIG_M): subtract BIG_M × each constraint row
  for (let i = 0; i < m; i++)
    for (let j = 0; j <= nv; j++) tab[m][j] -= BIG_M * tab[i][j];

  const basis = Array.from({length: m}, (_, i) => nc + m + i);
  for (let iter = 0; iter < 500; iter++) {
    let pivCol = -1, pivVal = -1e-9;
    for (let j = 0; j < nv; j++) if (tab[m][j] < pivVal) { pivVal = tab[m][j]; pivCol = j; }
    if (pivCol < 0) break;
    let pivRow = -1, minRatio = Infinity;
    for (let i = 0; i < m; i++) {
      const e = tab[i][pivCol];
      if (e > 1e-9) { const r = tab[i][nv] / e; if (r < minRatio - 1e-12) { minRatio = r; pivRow = i; } }
    }
    if (pivRow < 0) break;
    basis[pivRow] = pivCol;
    const piv = tab[pivRow][pivCol];
    for (let j = 0; j <= nv; j++) tab[pivRow][j] /= piv;
    for (let i = 0; i <= m; i++) {
      if (i === pivRow || Math.abs(tab[i][pivCol]) < 1e-12) continue;
      const f = tab[i][pivCol];
      for (let j = 0; j <= nv; j++) tab[i][j] -= f * tab[pivRow][j];
    }
  }
  const x = new Array(nc).fill(0);
  for (let i = 0; i < m; i++) if (basis[i] < nc) x[basis[i]] = tab[i][nv];
  return x;
}

// ─── Fast single-stat solver for unlock requirements ─────────────────────────
// When we only need to raise one stat by `need` points, just use the best material for it.
function solveSingleStat(cands, statIdx, need) {
  let bestMat = null, bestCoeff = 0;
  for (const m of cands) {
    const c = m[2 + statIdx] || 0;
    if (c > bestCoeff) { bestCoeff = c; bestMat = m; }
  }
  if (!bestMat || bestCoeff === 0) {
    return { feedCounts: {}, totalFeeds: Infinity, pointsAdded: Array(8).fill(0) };
  }
  const count = Math.ceil(need / bestCoeff);
  const feedCounts = { [bestMat[1]]: count };
  const pointsAdded = Array(8).fill(0);
  for (let s = 0; s < 8; s++) pointsAdded[s] = count * (bestMat[2 + s] || 0);
  return { feedCounts, totalFeeds: count, pointsAdded };
}

// ─── Multi-start greedy (construction heuristic) ─────────────────────────────
// Builds a feasible solution bottom-up. Runs once unconstrained, then once with
// each material forced as the first pick — returns the best (fewest feeds).
// Each run picks the material with max Σ min(remaining[s], bonus[s]), then
// post-prunes any unit whose removal still satisfies all constraints.
function multiStartGreedy(cands, solvable) {
  const nc = cands.length;

  function oneRun(forcedFirst) {
    const rem = [...solvable];
    const x = new Array(nc).fill(0);
    if (forcedFirst >= 0) {
      x[forcedFirst]++;
      const b = cands[forcedFirst];
      for (let s = 0; s < 8; s++) rem[s] = Math.max(rem[s] - (b[2 + s] || 0), 0);
    }
    for (let iter = 0; iter < 2000; iter++) {
      if (rem.every(r => r <= 0)) break;
      let bestIdx = -1, bestRed = 0;
      for (let mi = 0; mi < nc; mi++) {
        let red = 0;
        for (let s = 0; s < 8; s++) red += Math.min(rem[s], cands[mi][2 + s] || 0);
        if (red > bestRed) { bestRed = red; bestIdx = mi; }
      }
      if (bestIdx < 0) break;
      x[bestIdx]++;
      for (let s = 0; s < 8; s++) rem[s] = Math.max(rem[s] - (cands[bestIdx][2 + s] || 0), 0);
    }
    // Post-prune: remove any unit still satisfying constraints
    const surplus = new Array(8).fill(0);
    for (let mi = 0; mi < nc; mi++)
      for (let s = 0; s < 8; s++) surplus[s] += x[mi] * (cands[mi][2 + s] || 0);
    for (let s = 0; s < 8; s++) surplus[s] -= solvable[s];
    let changed = true;
    while (changed) {
      changed = false;
      for (let mi = 0; mi < nc; mi++) {
        if (x[mi] === 0) continue;
        if (surplus.every((sv, s) => sv >= (cands[mi][2 + s] || 0))) {
          x[mi]--;
          for (let s = 0; s < 8; s++) surplus[s] -= (cands[mi][2 + s] || 0);
          changed = true;
        }
      }
    }
    return x;
  }

  let bestX = oneRun(-1);
  let bestTotal = bestX.reduce((t, v) => t + v, 0);
  for (let fi = 0; fi < nc; fi++) {
    // Skip if this material has no useful reduction on current needs
    let red = 0;
    for (let s = 0; s < 8; s++) red += Math.min(solvable[s], cands[fi][2 + s] || 0);
    if (red === 0) continue;
    const x = oneRun(fi);
    const total = x.reduce((t, v) => t + v, 0);
    if (total < bestTotal) { bestTotal = total; bestX = x; }
  }
  return bestX;
}

// ─── Core tier solver (LP pre-solve + memoized B&B) ──────────────────────────
// Solves: minimize total feeds from cands[] s.t. each stat's needed[] is covered.
// Returns { feedCounts:{name->count}, totalFeeds, pointsAdded:[8] }
export function solveTier(cands, needed) {
  const nc = cands.length;

  const maxCoeff = Array(8).fill(0);
  for (const mat of cands) for (let s = 0; s < 8; s++) maxCoeff[s] = Math.max(maxCoeff[s], mat[2 + s] || 0);

  const solvable = needed.map((n, s) => maxCoeff[s] > 0 ? n : 0);

  function lowerBound(residual) {
    let lb = 0;
    for (let s = 0; s < 8; s++)
      if (residual[s] > 0 && maxCoeff[s] > 0) lb = Math.max(lb, Math.ceil(residual[s] / maxCoeff[s]));
    return lb;
  }

  const lpX = solveLP(cands, solvable, nc);
  const initX = lpX.map(v => Math.ceil(v - 1e-9));

  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < nc; i++) {
      if (initX[i] === 0) continue;
      initX[i]--;
      let ok = true;
      for (let s = 0; s < 8; s++) {
        if (solvable[s] <= 0) continue;
        let cov = 0;
        for (let j = 0; j < nc; j++) cov += initX[j] * (cands[j][2 + s] || 0);
        if (cov < solvable[s]) { ok = false; break; }
      }
      if (!ok) initX[i]++;
      else improved = true;
    }
  }

  // Run multi-start greedy and take the better of the two constructions.
  const greedyX = multiStartGreedy(cands, solvable);
  const greedyTotal = greedyX.reduce((t, v) => t + v, 0);
  const lpTotal = initX.reduce((t, v) => t + v, 0);
  const useGreedy = greedyTotal < lpTotal;

  const finalX = useGreedy ? greedyX : [...initX];
  let finalTotal = useGreedy ? greedyTotal : lpTotal;

  // Only run B&B for small instances — LP+greedy is near-optimal for large ones.
  // For large finalTotal the DFS search space explodes and provides negligible gain.
  if (finalTotal <= 30 && solvable.some(n => n > 0)) {
    const x = new Array(nc).fill(0);
    const memo = new Map();
    const tStart = Date.now();

    function dfs(level, currentTotal, residual) {
      if (Date.now() - tStart > 300) return;
      if (residual.every(r => r <= 0)) {
        if (currentTotal < finalTotal) {
          finalTotal = currentTotal;
          for (let i = 0; i < nc; i++) finalX[i] = x[i];
        }
        return;
      }
      if (level === nc) return;
      if (currentTotal + lowerBound(residual) >= finalTotal) return;
      const key = level + '|' + residual.join(',');
      if (memo.has(key) && currentTotal + memo.get(key) >= finalTotal) return;
      const prevFinalTotal = finalTotal;
      const mat = cands[level];
      let statMax = 0;
      for (let s = 0; s < 8; s++) {
        const p = mat[2 + s] || 0;
        if (p > 0 && residual[s] > 0) statMax = Math.max(statMax, Math.ceil(residual[s] / p));
      }
      const xMax = Math.min(statMax, finalTotal - currentTotal - 1);
      for (let xi = 0; xi <= xMax; xi++) {
        x[level] = xi;
        const newRes = residual.map((r, s) => Math.max(r - xi * (mat[2 + s] || 0), 0));
        dfs(level + 1, currentTotal + xi, newRes);
      }
      x[level] = 0;
      if (finalTotal < prevFinalTotal) {
        const best = finalTotal - currentTotal;
        if (!memo.has(key) || memo.get(key) > best) memo.set(key, best);
      }
    }

    dfs(0, 0, [...solvable]);
  }

  const feedCounts = {};
  const pointsAdded = Array(8).fill(0);
  for (let i = 0; i < nc; i++) {
    if (finalX[i] > 0) {
      feedCounts[cands[i][1]] = finalX[i];
      for (let s = 0; s < 8; s++) pointsAdded[s] += finalX[i] * (cands[i][2 + s] || 0);
    }
  }
  return { feedCounts, totalFeeds: finalTotal, pointsAdded };
}

// ─── Multi-phase optimizer core (reusable) ────────────────────────────────────
// Returns { phases, grandTotal, unsolvable }
// mode: 'normal'        → try all higher tiers as unlock targets
//       'less-training' → only try the immediately next tier (one step at a time)
//       'no-training'   → no unlocks at all
export function runOptimizer(startLevels, remaining, targetH, mode = 'normal', maxLevels = null, tierCap = null) {
  const phases     = [];
  const unsolvable = new Set();
  let curLevels    = [...startLevels];
  remaining        = [...remaining];
  let safety = 0;

  while (remaining.some(r => r > 0) && safety++ < 30) {
    const H = Math.max(...curLevels);
    const curTier = tierCap !== null ? Math.min(tierCap, maxUsableTier(H)) : maxUsableTier(H);
    if (curTier === -1) break;
    const cands = candsSorted(curTier);

    const maxCoeff = Array(8).fill(0);
    for (const mat of cands) for (let s = 0; s < 8; s++) maxCoeff[s] = Math.max(maxCoeff[s], mat[2 + s] || 0);
    for (let s = 0; s < 8; s++) if (remaining[s] > 0 && maxCoeff[s] === 0) unsolvable.add(s);

    // Baseline: solve everything at the current tier (no unlock).
    const stayResult     = solveTier(cands, remaining);
    let bestCost         = stayResult.totalFeeds;
    let bestUnlockPhase  = null;
    let bestNewLevels    = null;
    let bestNewRemaining = null;

    // Build candidate unlock tiers based on mode.
    const unlockTiers = mode === 'no-training' ? [] :
      TIER_THRESHOLDS.filter(t => t > curTier && t <= targetH)
        .slice(0, mode === 'less-training' ? 1 : undefined);

    for (const targetTier of unlockTiers) {
      const targetCands = candsSorted(targetTier);

      for (let uIdx = 0; uIdx < 8; uIdx++) {
        const gap = targetTier - curLevels[uIdx];
        if (gap <= 0 || maxCoeff[uIdx] === 0) continue;
        if (maxLevels && targetTier > maxLevels[uIdx]) continue;

        // Fast single-stat solve: raising one stat to unlock the next tier
        // only needs the best material for that stat — no LP/DFS required.
        const unlockResult = solveSingleStat(cands, uIdx, gap);
        if (unlockResult.totalFeeds === Infinity) continue;

        const remainAfter = remaining.map((r, s) => Math.max(r - unlockResult.pointsAdded[s], 0));
        const nextResult  = solveTier(targetCands, remainAfter);
        const totalCost   = unlockResult.totalFeeds + nextResult.totalFeeds;

        if (totalCost < bestCost) {
          bestCost = totalCost;
          bestUnlockPhase  = {
            label: `Tier ${curTier} — raising ${STATS[uIdx]} to unlock Tier ${targetTier}`,
            ...unlockResult,
          };
          bestNewLevels    = curLevels.map((c, s) => c + unlockResult.pointsAdded[s]);
          bestNewRemaining = remainAfter;
        }
      }
    }

    if (!bestUnlockPhase) {
      phases.push({ label: `Tier ${curTier}`, ...stayResult });
      break;
    }

    phases.push(bestUnlockPhase);
    curLevels = maxLevels ? bestNewLevels.map((c, i) => Math.min(c, maxLevels[i])) : bestNewLevels;
    remaining = bestNewRemaining;
  }

  return { phases, grandTotal: phases.reduce((t, p) => t + p.totalFeeds, 0), unsolvable };
}
