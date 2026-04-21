import { MATERIALS, STATS } from './data.js';
import { maxUsableTier, runOptimizer } from './solver.js';
import {
  computeBreedingDP, findBestDP, traceBreedPath,
  breedFeedCostGen0, breedFeedCostGenN, breedFeedsGenN, fmtH,
} from './breeding.js';

const LS_KEY        = "wynnmounts_stats";
const LS_MOUNTS_KEY = "wynnmounts_mounts";

// ─── One-time migration from old wynnbreeder_* keys ──────────────────────────
(function migrateLegacyKeys() {
  const renames = [["wynnbreeder_stats", LS_KEY], ["wynnbreeder_mounts", LS_MOUNTS_KEY]];
  for (const [oldKey, newKey] of renames) {
    if (localStorage.getItem(newKey) === null) {
      const val = localStorage.getItem(oldKey);
      if (val !== null) { localStorage.setItem(newKey, val); }
    }
    localStorage.removeItem(oldKey);
  }
})();

// ─── Feed tracker (stored inside mount profile) ───────────────────────────────

let fedItems = new Set();
let activeMountName = null; // null = no named mount loaded
let _lastImportedName = '';

function saveFedItems() {
  if (activeMountName === null) return; // no mount active, nothing to persist
  const mounts = loadMounts();
  if (!mounts[activeMountName]) return;
  mounts[activeMountName].fedItems = [...fedItems];
  saveMounts(mounts);
}

function clearFedItems() {
  fedItems = new Set();
  saveFedItems();
}

// ─── Saved mounts ─────────────────────────────────────────────────────────────

function loadMounts() {
  try {
    const raw = localStorage.getItem(LS_MOUNTS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveMounts(mounts) {
  try { localStorage.setItem(LS_MOUNTS_KEY, JSON.stringify(mounts)); } catch {}
}

function saveMountProfile(name) {
  const mounts = loadMounts();
  const stats = [];
  for (let i = 0; i < 8; i++) {
    stats.push({
      cur: document.getElementById(`cur-${i}`).value,
      lim: document.getElementById(`lim-${i}`).value,
      max: document.getElementById(`max-${i}`).value,
    });
  }
  // preserve existing fedItems if overwriting same profile
  const existing = mounts[name];
  mounts[name] = {
    stats,
    tierSlots: document.querySelector('#tier-selector .tier-btn.active')?.dataset.slots ?? '3',
    fedItems: activeMountName === name ? [...fedItems] : (existing?.fedItems ?? []),
  };
  saveMounts(mounts);
  activeMountName = name;
  fedItems = new Set(mounts[name].fedItems);
  renderSavedMounts();
}

function loadMountProfile(name) {
  const mounts = loadMounts();
  const profile = mounts[name];
  if (!profile) return;
  profile.stats.forEach((s, i) => {
    document.getElementById(`cur-${i}`).value = s.cur;
    document.getElementById(`lim-${i}`).value = s.lim;
    document.getElementById(`max-${i}`).value = s.max;
  });
  if (profile.tierSlots != null) {
    document.querySelectorAll('#tier-selector .tier-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.slots === profile.tierSlots);
    });
  }
  activeMountName = name;
  fedItems = new Set(profile.fedItems ?? []);
  updateDerived();
  runSolver();
  renderRoadmap();
  renderSavedMounts();
}

function deleteMountProfile(name) {
  const mounts = loadMounts();
  delete mounts[name];
  saveMounts(mounts);
  if (activeMountName === name) {
    activeMountName = null;
    fedItems = new Set();
  }
  renderSavedMounts();
}

function renameMountProfile(oldName, newName) {
  if (!newName || newName === oldName) return;
  const mounts = loadMounts();
  if (!mounts[oldName]) return;
  const rebuilt = {};
  for (const [k, v] of Object.entries(mounts)) {
    rebuilt[k === oldName ? newName : k] = v;
  }
  saveMounts(rebuilt);
  if (activeMountName === oldName) activeMountName = newName;
  renderSavedMounts();
}

function renderSavedMounts() {
  const list = document.getElementById('saved-mounts-list');
  if (!list) return;
  const mounts = loadMounts();
  const names = Object.keys(mounts);
  if (names.length === 0) {
    list.innerHTML = '<div class="saved-mounts-empty">No saved mounts yet.</div>';
    return;
  }
  list.innerHTML = names.map(name => {
    const escaped = name.replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const pot = mounts[name].stats.reduce((s, st) => s + (parseFloat(st.max) || 0), 0);
    const isActive = name === activeMountName;
    return `<div class="saved-mount-item${isActive ? ' saved-mount-active' : ''}">
      <div class="saved-mount-info">
        <span class="saved-mount-name">${escaped}</span>
        <span class="saved-mount-pot">${pot} pot</span>
      </div>
      <div class="saved-mount-actions">
        <button class="btn-apply-mount" data-name="${escaped}">${isActive ? 'Active' : 'Apply'}</button>
        <button class="btn-resave-mount" data-name="${escaped}" title="Re-save current stats">💾</button>
        <button class="btn-rename-mount" data-name="${escaped}" title="Rename">✎</button>
        <button class="btn-del-mount" data-name="${escaped}" title="Delete">✕</button>
      </div>
    </div>`;
  }).join('');
}

// ─── Build input rows ─────────────────────────────────────────────────────────

const tbody = document.getElementById("stat-rows");

STATS.forEach((stat, i) => {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td class="stat-name">${stat}</td>
    <td><input type="number" min="0" id="cur-${i}" value="1"></td>
    <td><input type="number" min="0" id="lim-${i}" value="10"></td>
    <td><input type="number" min="0" id="max-${i}" value="30"></td>
    <td class="derived" id="need-${i}">—</td>
    <td class="derived" id="pct-${i}">—</td>
  `;
  tbody.appendChild(tr);
});

// ─── Live-derived columns ─────────────────────────────────────────────────────

function updateDerived() {
  let maxPotential = 0;
  for (let i = 0; i < 8; i++) {
    const cur = parseFloat(document.getElementById(`cur-${i}`).value) || 0;
    const lim = parseFloat(document.getElementById(`lim-${i}`).value) || 0;
    const max = parseFloat(document.getElementById(`max-${i}`).value) || 0;
    maxPotential += max;

    const need = Math.max(max - lim, 0);
    const pct  = max > 0 ? Math.round((cur / max) * 100) : 0;

    document.getElementById(`need-${i}`).textContent = (max || lim) ? need : "—";
    const pctEl = document.getElementById(`pct-${i}`);
    if (max) {
      pctEl.innerHTML = `<div class="stat-progress"><div class="stat-progress-bar" style="width:${pct}%"></div><span class="stat-progress-text">${pct}%</span></div>`;
    } else {
      pctEl.textContent = "—";
    }
  }
  const avg = Math.max(...Array.from({length: 8}, (_, i) => parseFloat(document.getElementById(`cur-${i}`).value) || 0));
  document.getElementById("avg-display").textContent = avg;
  document.getElementById("mount-potential-display").textContent = maxPotential.toLocaleString();
  saveToStorage();
}

document.querySelectorAll("input[type=number]").forEach(inp => {
  inp.addEventListener("input", updateDerived);
});

let _trainMode = 'normal';

function getTrainMode() { return _trainMode; }

function setTrainMode(mode) {
  _trainMode = mode;
  document.querySelectorAll('.train-mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  document.getElementById('chk-no-train').checked = (mode === 'no-training');
}

document.querySelectorAll('.train-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    setTrainMode(btn.dataset.mode);
    saveToStorage();
    runSolver();
    renderRoadmap();
  });
});

document.getElementById('chk-level-cap').addEventListener('change', (e) => {
  document.getElementById('inp-level-cap').disabled = !e.target.checked;
  runSolver();
});
document.getElementById('inp-level-cap').addEventListener('input', runSolver);

// ─── localStorage ─────────────────────────────────────────────────────────────

function saveToStorage() {
  const data = {};
  for (let i = 0; i < 8; i++) {
    data[`cur-${i}`] = document.getElementById(`cur-${i}`).value;
    data[`lim-${i}`] = document.getElementById(`lim-${i}`).value;
    data[`max-${i}`] = document.getElementById(`max-${i}`).value;
  }
  data.trainMode  = getTrainMode();
  data.tierSlots  = document.querySelector('#tier-selector .tier-btn.active')?.dataset.slots ?? '3';
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch {}
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    for (let i = 0; i < 8; i++) {
      if (data[`cur-${i}`] != null) document.getElementById(`cur-${i}`).value = data[`cur-${i}`];
      if (data[`lim-${i}`] != null) document.getElementById(`lim-${i}`).value = data[`lim-${i}`];
      if (data[`max-${i}`] != null) document.getElementById(`max-${i}`).value = data[`max-${i}`];
    }
    setTrainMode(data.trainMode ?? (data.noTraining ? 'no-training' : 'normal'));
    if (data.tierSlots  != null) {
      document.querySelectorAll('#tier-selector .tier-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.slots === data.tierSlots);
      });
    }
  } catch {}
  updateDerived();
}

// ─── Feed optimizer entry point ───────────────────────────────────────────────

function calculateOptimalList() {
  const statData = STATS.map((_, i) => ({
    cur: parseFloat(document.getElementById(`cur-${i}`).value) || 0,
    lim: parseFloat(document.getElementById(`lim-${i}`).value) || 0,
    max: parseFloat(document.getElementById(`max-${i}`).value) || 0,
  }));

  const resultDiv  = document.getElementById("results");
  const resultBody = document.getElementById("result-body");
  const warnRow    = document.getElementById("warn-row");
  const warnText   = document.getElementById("warn-text");

  resultBody.innerHTML = "";
  warnRow.style.display = "none";
  resultDiv.style.display = "block";

  const mode      = getTrainMode();
  const rawCur    = statData.map(s => s.cur);
  const effCur    = statData.map(s => Math.max(s.cur, Math.min(s.lim, s.max)));
  const remaining = statData.map(s => Math.max(s.max - s.lim, 0));
  let   targetH   = Math.max(...statData.map(s => s.max));

  const levelCapEnabled = document.getElementById('chk-level-cap')?.checked;
  const playerLevelCap  = levelCapEnabled ? (parseInt(document.getElementById('inp-level-cap')?.value) || 115) : null;

  if (remaining.every(r => r === 0)) {
    resultBody.innerHTML = `<tr><td colspan="5" class="no-materials">All stats already at max level.</td></tr>`;
    return;
  }

  const rawH = Math.max(...rawCur);
  let   effH = Math.max(...effCur);
  if (playerLevelCap !== null) {
    targetH = Math.min(targetH, playerLevelCap);
    effH    = Math.min(effH, playerLevelCap);
  }
  const rawTier = maxUsableTier(rawH);
  const effTier = maxUsableTier(effH);

  if (Math.max(rawTier, effTier) === -1) {
    resultBody.innerHTML = `<tr><td colspan="5" class="no-materials">No materials available at your current highest level (${rawH}). Train your mount to at least level 1.</td></tr>`;
    return;
  }

  // Build candidate plans based on training mode.
  // 'no-training'   → only solve at current tier, no unlocks
  // 'less-training' → allow next-tier-only unlocks; also try effCur (train to existing limit)
  // 'normal'        → full optimizer: try all tier jumps + multi-tier from scratch
  const maxLevels = statData.map(s => s.max);
  const planBase  = runOptimizer(rawCur, remaining, targetH, mode, maxLevels);
  const trainHelps = mode !== 'no-training' && effH > rawH && effTier > rawTier;
  const planTrain  = trainHelps ? runOptimizer(effCur, remaining, targetH, mode, maxLevels) : null;
  const planMultiTier = mode === 'normal' && rawTier > 1
    ? runOptimizer(Array(8).fill(1), remaining, targetH, 'normal', maxLevels)
    : null;

  const allPlans = [planBase, planTrain, planMultiTier].filter(p => p !== null);
  const chosen   = allPlans.reduce((best, p) => p.grandTotal < best.grandTotal ? p : best);
  const useTrain = planTrain !== null && chosen === planTrain;

  const matByName = {};
  MATERIALS.forEach(m => { matByName[m[1]] = m; });

  const allPhases = [];
  if (useTrain) {
    const saved = planBase.grandTotal - planTrain.grandTotal;
    const neededLevel = effTier;
    allPhases.push({
      label: `Train your mount to at least level ${neededLevel} first (saves ${saved} feed${saved === 1 ? '' : 's'})`,
      feedCounts: {},
      totalFeeds: 0,
      isTraining: true,
    });
  }
  allPhases.push(...chosen.phases);

  const multiPhase = chosen.phases.length > 1;

  for (const phase of allPhases) {
    if (multiPhase || phase.isTraining) {
      const headerTr = document.createElement("tr");
      headerTr.className = phase.isTraining ? "train-row" : "phase-header";
      headerTr.innerHTML = `<td colspan="5">${phase.isTraining ? "⚔ " : ""}${phase.label}</td>`;
      resultBody.appendChild(headerTr);
    }
    if (phase.isTraining) continue;

    const entries = Object.entries(phase.feedCounts).sort((a, b) => b[1] - a[1]);
    for (const [name, count] of entries) {
      const mat     = matByName[name];
      const pts     = mat.slice(2);
      const raises  = STATS.map((s, i) => pts[i] > 0 ? `${s} (+${pts[i]})` : null).filter(Boolean).join(", ");
      const totalPts = pts.reduce((a, b) => a + (b || 0), 0) * count;
      const isFed = fedItems.has(name);
      const safeName = name.replace(/"/g, '&quot;');
      const tr = document.createElement("tr");
      if (isFed) tr.classList.add('row-fed');
      tr.innerHTML = `<td>${name}</td><td>${raises}</td><td>${count}</td><td>${totalPts}</td><td class="fed-cell"><input type="checkbox" class="fed-chk" data-name="${safeName}" ${isFed ? 'checked' : ''} title="Mark as fed"></td>`;
      resultBody.appendChild(tr);
    }
  }

  const totalTr = document.createElement("tr");
  totalTr.className = "total-row";
  totalTr.innerHTML = `<td colspan="5">Total feeds: ${chosen.grandTotal}</td>`;
  resultBody.appendChild(totalTr);

  if (chosen.unsolvable.size > 0) {
    const blocked = [...chosen.unsolvable].map(i => STATS[i]).join(", ");
    warnText.textContent = `⚠ Couldn't fully max: ${blocked}. Train your mount to unlock higher-tier materials.`;
    warnRow.style.display = "block";
  }
}

// ─── Multi-Gen Breeding Roadmap renderer ─────────────────────────────────────

function renderRoadmap() {
  const targetPot  = parseInt(document.getElementById('inp-target-pot').value) || 1180;
  const curPot     = parseInt(document.getElementById('inp-cur-pot').value) || 0;
  const noTrain    = document.getElementById('chk-no-train').checked;
  const tierSlots  = parseInt(document.querySelector('#tier-selector .tier-btn.active')?.dataset.slots ?? '3');
  const parallelPairs = tierSlots;
  const fallbackLvl = Math.max(1, Math.floor(curPot / 8));

  const dp   = computeBreedingDP(!noTrain, fallbackLvl);
  const best = findBestDP(dp, targetPot);
  const body = document.getElementById('roadmap-body');
  const tip  = document.getElementById('tip-banner');

  if (!best) {
    body.innerHTML = `<tr><td colspan="4" style="color:var(--muted);padding:16px;text-align:center;font-style:italic;">No viable path found for target ${targetPot}.</td></tr>`;
    tip.innerHTML = '';
    return;
  }

  const path = traceBreedPath(dp, best);
  let html = '';
  const stepHoursArr = [];

  let currentStepIndex = -1;
  if (curPot > 0) {
    currentStepIndex = path.findIndex(s => s.M_curr * 8 > curPot);
  }

  for (let i = 0; i < path.length; i++) {
    const step = path[i];
    const noFeed    = step.L_prev <= step.base;
    const lvl       = !noTrain ? step.M_prev : fallbackLvl;
    const isCurrent = i === currentStepIndex;

    let action;
    if (step.isGen1) {
      action = noFeed
        ? `Feed base parents to minimum (avg limit 20), then breed`
        : `Feed base parents to avg limit <b>${step.L_prev}</b> each, then breed`;
    } else if (noFeed) {
      action = `<b>Don't feed</b> — breed your current horses immediately`;
    } else {
      action = `Feed parents to avg limit <b>${step.L_prev}</b>, then breed two`;
    }

    const stepHours = step.isGen1
      ? 2 * breedFeedCostGen0(step.L_prev) + 6
      : 2 * breedFeedCostGenN(step.base, step.L_prev, lvl) + 6;
    const stepFeeds = step.isGen1 ? '—' :
      (2 * breedFeedsGenN(step.base, step.L_prev, lvl)) + ' feeds';
    stepHoursArr.push(stepHours);

    const cls = isCurrent ? 'gen-step-current' : '';
    html += `<tr class="${cls}">
      <td>${isCurrent ? '⭐ Your next step' : `Breed step ${step.gen}`}</td>
      <td>${action}</td>
      <td>${step.M_curr * 8} pot</td>
      <td>${fmtH(stepHours)}<br><span style="color:var(--muted);font-size:0.8em">${stepFeeds}</span></td>
    </tr>`;
  }

  const P = path.length;
  let parallelElapsed = 0;
  stepHoursArr.forEach((sh, i) => {
    parallelElapsed += Math.ceil(Math.pow(2, P - 1 - i) / parallelPairs) * sh;
  });

  const totalCost = dp[best.gen][best.M].cost;
  const totalHorses = Math.pow(2, path.length);
  const stepsRemaining = currentStepIndex >= 0 ? path.length - currentStepIndex : path.length;
  const remainingHorses = Math.pow(2, stepsRemaining);
  const horseNote = curPot > 0 && currentStepIndex > 0
    ? `<b>${remainingHorses}</b> more base horses needed from your current point (<b>${totalHorses}</b> total from scratch)`
    : `<b>${totalHorses}</b> base horses needed total`;
  html += `<tr class="roadmap-total">
    <td colspan="4">Full tree from scratch: <b>~${fmtH(parallelElapsed)}</b> real elapsed — reaching ~${best.M * 8} potential<br><span style="font-weight:400;font-size:0.85em;opacity:0.85">🐴 ${horseNote}</span></td>
  </tr>`;
  body.innerHTML = html;

  // Time Saved tip — only shown when "Ignore Training" is checked
  if (noTrain) {
    const dpT  = computeBreedingDP(true, fallbackLvl);
    const bestT = findBestDP(dpT, targetPot);
    if (bestT) {
      const savedHours = totalCost - dpT[bestT.gen][bestT.M].cost;
      if (savedHours > 0.09) {
        const feedsSaved = Math.round(savedHours / 6);
        const curStep    = path.find(s => currentStepIndex < 0 || (curPot / 8) < s.M_curr);
        const trainToLvl = curStep ? curStep.M_prev : Math.ceil(targetPot / 8);
        tip.innerHTML = `<div class="tip-box">💡 If you train your horse to Level <b>${trainToLvl}</b>, you will save approximately <b>${feedsSaved} total feeds</b> (<b>${fmtH(savedHours)}</b> of passive wait time) across the full breeding tree.</div>`;
        return;
      }
    }
  }
  tip.innerHTML = '';
}

// ─── Async runner: shows spinner then defers solver so browser can paint ──────

function runSolver() {
  const rb = document.getElementById("result-body");
  rb.innerHTML = '<tr><td colspan="5" class="loading-cell"><span class="spinner"></span>Calculating…</td></tr>';
  document.getElementById("warn-row").style.display = "none";
  document.getElementById("results").style.display = "block";
  requestAnimationFrame(() => setTimeout(() => {
    const t0 = performance.now();
    calculateOptimalList();
    console.log(`[solver] ${(performance.now() - t0).toFixed(1)}ms`);
  }, 0));
}

// ─── Import from clipboard ────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
async function importFromClipboard() {
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {}

  if (!text) {
    text = window.prompt('Paste your horse JSON here:') ?? '';
  }
  if (!text.trim()) return;

  let data;
  try { data = JSON.parse(text); } catch {
    alert("Import failed: pasted text is not valid JSON.");
    return;
  }

  if (data?.type && typeof data.type !== 'string') {
    alert('Invalid format: "type" must be a string when provided.');
    return;
  }

  const s = data?.stats;
  if (!s || typeof s !== 'object') {
    alert("Invalid format: missing \"stats\" object.");
    return;
  }

  const statKeyMap = {
    Speed: 'speed',
    Acceleration: 'acceleration',
    Altitude: 'altitude',
    Energy: 'energy',
    Handling: 'handling',
    Toughness: 'toughness',
    Boost: 'boost',
    Training: 'training',
  };

  for (let i = 0; i < STATS.length; i++) {
    const entry = s[STATS[i]] ?? s[statKeyMap[STATS[i]]];
    if (!entry || typeof entry !== 'object') {
      alert(`Invalid format: missing stat "${STATS[i]}".`);
      return;
    }
    const hasLegacyShape = 'Level' in entry && 'Limit' in entry && 'Max' in entry;
    const hasHorseShape = 'value' in entry && 'limit' in entry && 'maxValue' in entry;
    if (!hasLegacyShape && !hasHorseShape) {
      alert(`Invalid format: stat "${STATS[i]}" missing value/limit/maxValue.`);
      return;
    }
  }

  for (let i = 0; i < STATS.length; i++) {
    const entry = s[STATS[i]] ?? s[statKeyMap[STATS[i]]];
    const cur = entry.Level ?? entry.value ?? 0;
    const lim = entry.Limit ?? entry.limit ?? 0;
    const max = entry.Max ?? entry.maxValue ?? 0;
    document.getElementById(`cur-${i}`).value = cur;
    document.getElementById(`lim-${i}`).value = lim;
    document.getElementById(`max-${i}`).value = max;
  }

  if (Number.isFinite(data?.potential)) {
    document.getElementById('inp-cur-pot').value = data.potential;
  }

  _lastImportedName = typeof data?.name === 'string' ? data.name.trim() : '';

  updateDerived();
  runSolver();
  renderRoadmap();
}

// ─── Import button tooltip ────────────────────────────────────────────────────

const _importBtn = document.getElementById('btn-import');
const _tooltip = document.createElement('div');
_tooltip.id = 'import-tooltip';
_tooltip.textContent = _importBtn.dataset.tooltip;
document.body.appendChild(_tooltip);

_importBtn.addEventListener('mouseenter', () => {
  const r = _importBtn.getBoundingClientRect();
  const centeredLeft = r.left + (r.width - _tooltip.offsetWidth) / 2;
  _tooltip.style.left = Math.max(8, centeredLeft) + 'px';
  _tooltip.style.top  = (r.top - _tooltip.offsetHeight - 6) + 'px';
  _tooltip.classList.add('visible');
});
_importBtn.addEventListener('mouseleave', () => _tooltip.classList.remove('visible'));
_importBtn.addEventListener('click', importFromClipboard);

// ─── Clear button ─────────────────────────────────────────────────────────────

document.getElementById("btn-clear").addEventListener("click", () => {
  for (let i = 0; i < 8; i++) {
    document.getElementById(`cur-${i}`).value = 1;
    document.getElementById(`lim-${i}`).value = 10;
    document.getElementById(`max-${i}`).value = 30;
  }
  setTrainMode('normal');
  clearFedItems();
  try { localStorage.removeItem(LS_KEY); } catch {}
  updateDerived();
  runSolver();
});

document.getElementById("btn-calc").addEventListener("click", () => { runSolver(); });

// ─── Roadmap event listeners ──────────────────────────────────────────────────

document.getElementById('inp-cur-pot').addEventListener('input', renderRoadmap);
document.getElementById('inp-target-pot').addEventListener('input', renderRoadmap);

document.querySelectorAll('#tier-selector .tier-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#tier-selector .tier-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    saveToStorage();
    renderRoadmap();
  });
});

// ─── Tabs ─────────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).style.display = 'block';
    if (btn.dataset.tab === 'breeding') renderRoadmap();
  });
});

// ─── Fed checkbox delegation (permanent) ─────────────────────────────────────

document.getElementById('result-body').addEventListener('change', (e) => {
  if (!e.target.classList.contains('fed-chk')) return;
  const name = e.target.dataset.name;
  if (e.target.checked) { fedItems.add(name); } else { fedItems.delete(name); }
  saveFedItems();
  const row = e.target.closest('tr');
  if (row) row.classList.toggle('row-fed', e.target.checked);
});

// ─── Sidebar event listeners ──────────────────────────────────────────────────

function showNewSaveForm() {
  const list = document.getElementById('saved-mounts-list');
  const existing = list.querySelector('.new-save-form');
  if (existing) { existing.querySelector('input').focus(); return; }

  const form = document.createElement('div');
  form.className = 'new-save-form';
  const pre = _lastImportedName.replace(/"/g, '&quot;');
  form.innerHTML = `
    <input type="text" placeholder="Name this mount…" maxlength="32" value="${pre}">
    <div class="new-save-btns">
      <button class="btn-new-save-confirm">Save</button>
      <button class="btn-new-save-cancel">✕</button>
    </div>
  `;
  list.insertBefore(form, list.firstChild);
  const input = form.querySelector('input');
  input.focus();
  input.select();

  const confirm = () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    saveMountProfile(name);
    _lastImportedName = '';
    form.remove();
  };
  const cancel = () => form.remove();

  form.querySelector('.btn-new-save-confirm').addEventListener('click', confirm);
  form.querySelector('.btn-new-save-cancel').addEventListener('click', cancel);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirm();
    if (e.key === 'Escape') cancel();
  });
}

document.getElementById('btn-save-mount').addEventListener('click', showNewSaveForm);

document.getElementById('saved-mounts-list').addEventListener('click', (e) => {
  const applyBtn  = e.target.closest('.btn-apply-mount');
  const resaveBtn = e.target.closest('.btn-resave-mount');
  const renameBtn = e.target.closest('.btn-rename-mount');
  const delBtn    = e.target.closest('.btn-del-mount');

  if (applyBtn)  { loadMountProfile(applyBtn.dataset.name); return; }
  if (resaveBtn) { saveMountProfile(resaveBtn.dataset.name); return; }
  if (delBtn)    { deleteMountProfile(delBtn.dataset.name); return; }

  if (renameBtn) {
    const item     = renameBtn.closest('.saved-mount-item');
    const nameSpan = item.querySelector('.saved-mount-name');
    const oldName  = renameBtn.dataset.name;

    const input = document.createElement('input');
    input.type      = 'text';
    input.className = 'mount-name-edit';
    input.value     = oldName;
    input.maxLength = 32;
    nameSpan.replaceWith(input);
    renameBtn.style.display = 'none';
    input.focus();
    input.select();

    const confirm = () => {
      const newName = input.value.trim();
      if (newName && newName !== oldName) {
        renameMountProfile(oldName, newName);
      } else {
        renderSavedMounts();
      }
    };
    input.addEventListener('blur', confirm);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') input.blur();
      if (ev.key === 'Escape') { ev.preventDefault(); renderSavedMounts(); }
    });
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

loadFromStorage();
renderSavedMounts();
runSolver();
