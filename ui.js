import { MATERIALS, STATS } from './data.js';
import { maxUsableTier, runOptimizer } from './solver.js';
import { simulateMany, summarizeDistribution, EST_KEYS } from './estimator.js';

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
let _lastImportedType = '';

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

function saveMountProfile(name, type) {
  const mounts = loadMounts();
  const stats = [];
  for (let i = 0; i < 8; i++) {
    stats.push({
      cur: document.getElementById(`cur-${i}`).value,
      lim: document.getElementById(`lim-${i}`).value,
      max: document.getElementById(`max-${i}`).value,
    });
  }
  // preserve existing fedItems and type if overwriting same profile
  const existing = mounts[name];
  const mountType = type || existing?.type || 'horse';
  mounts[name] = {
    stats,
    type: mountType,
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
  activeMountName = name;
  fedItems = new Set(profile.fedItems ?? []);
  updateDerived();
  runSolver();
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
  const horsesList = document.getElementById('saved-horses-list');
  const wyvernsList = document.getElementById('saved-wyverns-list');
  const adasaursList = document.getElementById('saved-adasaurs-list');
  if (!horsesList || !wyvernsList || !adasaursList) return;

  const mounts = loadMounts();
  const byType = { horse: [], wyvern: [], adasaur: [] };

  for (const name of Object.keys(mounts)) {
    const type = mounts[name].type || 'horse';
    (byType[type] ||= []).push(name);
  }

  function renderList(listEl, names) {
    if (names.length === 0) {
      listEl.innerHTML = '<div class="saved-mounts-empty">No saved mounts yet.</div>';
      return;
    }
    listEl.innerHTML = names.map(name => {
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

  renderList(horsesList, byType.horse);
  renderList(wyvernsList, byType.wyvern);
  renderList(adasaursList, byType.adasaur);
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
  data.trainMode = getTrainMode();
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

  const rawH    = Math.max(...rawCur);
  let   effH    = Math.max(...effCur);
  const tierCap = playerLevelCap !== null ? maxUsableTier(playerLevelCap) : null;
  if (playerLevelCap !== null) {
    targetH = Math.min(targetH, playerLevelCap);
    effH    = Math.min(effH, playerLevelCap);
  }
  const rawTier = tierCap !== null ? Math.min(tierCap, maxUsableTier(rawH)) : maxUsableTier(rawH);
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
  const planBase  = runOptimizer(rawCur, remaining, targetH, mode, maxLevels, tierCap);
  const trainHelps = mode !== 'no-training' && effH > rawH;
  const planTrain  = trainHelps ? runOptimizer(effCur, remaining, targetH, mode, maxLevels, tierCap) : null;
  const planMultiTier = mode === 'normal' && rawTier > 1
    ? runOptimizer(Array(8).fill(1), remaining, targetH, 'normal', maxLevels, tierCap)
    : null;

  const allPlans = [planBase, planTrain, planMultiTier].filter(p => p !== null);
  const chosen   = allPlans.reduce((best, p) => p.grandTotal < best.grandTotal ? p : best);
  const useTrain = planTrain !== null && chosen === planTrain;

  const matByName = {};
  MATERIALS.forEach(m => { matByName[m[1]] = m; });

  const allPhases = [];
  if (useTrain) {
    const saved = planBase.grandTotal - planTrain.grandTotal;
    const tierUnlock = effTier > rawTier;
    const label = tierUnlock
      ? `Train your mount to at least level ${effTier} first (saves ${saved} feed${saved === 1 ? '' : 's'})`
      : `Train your stats to their current limits first (saves ${saved} feed${saved === 1 ? '' : 's'})`;
    allPhases.push({
      label,
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

// ─── Breeding Estimator ───────────────────────────────────────────────────────

function buildEstimatorRows() {
  const tbodyA = document.getElementById('est-a-rows');
  const tbodyB = document.getElementById('est-b-rows');
  if (!tbodyA || !tbodyB) return;

  STATS.forEach((stat, i) => {
    const safe = stat.toLowerCase().replace(/\s+/g, '-');
    const trA = document.createElement('tr');
    trA.innerHTML = `
      <td class="stat-name">${stat}</td>
      <td><input type="number" min="0" id="est-a-${safe}-val" value="1"></td>
      <td><input type="number" min="0" id="est-a-${safe}-lim" value="10"></td>
      <td><input type="number" min="0" id="est-a-${safe}-max" value="30"></td>
    `;
    tbodyA.appendChild(trA);

    const trB = document.createElement('tr');
    trB.innerHTML = `
      <td class="stat-name">${stat}</td>
      <td><input type="number" min="0" id="est-b-${safe}-val" value="1"></td>
      <td><input type="number" min="0" id="est-b-${safe}-lim" value="10"></td>
      <td><input type="number" min="0" id="est-b-${safe}-max" value="30"></td>
    `;
    tbodyB.appendChild(trB);
  });
}

function readEstimatorParent(prefix) {
  const parent = {};
  for (let i = 0; i < STATS.length; i++) {
    const key = EST_KEYS[i];
    const safe = STATS[i].toLowerCase().replace(/\s+/g, '-');
    parent[`${key}_val`] = parseFloat(document.getElementById(`${prefix}-${safe}-val`).value) || 0;
    parent[`${key}_lim`] = parseFloat(document.getElementById(`${prefix}-${safe}-lim`).value) || 0;
    parent[`${key}_max`] = parseFloat(document.getElementById(`${prefix}-${safe}-max`).value) || 0;
  }
  parent.energy_value = parseFloat(document.getElementById(`${prefix}-energy-val`).value) || 0;
  parent.energy_max   = parseFloat(document.getElementById(`${prefix}-energy-max`).value) || 0;
  return parent;
}

function runEstimator() {
  const runs = parseInt(document.getElementById('est-runs').value) || 5000;
  const parentA = readEstimatorParent('est-a');
  const parentB = readEstimatorParent('est-b');

  const resultsDiv = document.getElementById('estimator-results');
  const body       = document.getElementById('est-results-body');
  const potDisplay = document.getElementById('est-potential-display');

  body.innerHTML = '<tr><td colspan="6" class="loading-cell"><span class="spinner"></span>Running Monte Carlo simulation…</td></tr>';
  resultsDiv.style.display = 'block';

  requestAnimationFrame(() => setTimeout(() => {
    const t0 = performance.now();
    const sims = simulateMany(parentA, parentB, runs);

    const pot = summarizeDistribution(sims.potential);
    potDisplay.innerHTML = `
      <div class="est-pot-block">
        <span class="est-pot-label">Minimum Potential</span>
        <span class="est-pot-value">${pot.min}</span>
      </div>
      <div class="est-pot-block">
        <span class="est-pot-label">Average Potential</span>
        <span class="est-pot-value">${pot.mean}</span>
      </div>
    `;

    let html = '';
    const fields = [
      { label: 'Speed',         key: 'speed',      show: ['max', 'lim'] },
      { label: 'Acceleration',  key: 'accel',      show: ['max', 'lim'] },
      { label: 'Altitude',      key: 'altitude',   show: ['max', 'lim'] },
      { label: 'Energy',        key: 'energy_stat',show: ['max', 'lim'] },
      { label: 'Handling',      key: 'handling',   show: ['max', 'lim'] },
      { label: 'Toughness',     key: 'toughness',  show: ['max', 'lim'] },
      { label: 'Boost',         key: 'boost',      show: ['max', 'lim'] },
      { label: 'Training',      key: 'training',   show: ['max', 'lim'] },
    ];

    fields.forEach((f, idx) => {
      f.show.forEach((field, fidx) => {
        const dist = summarizeDistribution(sims[`${f.key}_${field}`]);
        const cls = fidx === 0 ? 'est-row-group-start' : 'est-row-group-mid';
        const label = fidx === 0 ? f.label : '';
        html += `<tr class="${cls}">
          <td>${label}</td>
          <td>${field}</td>
          <td>${dist.min}</td>
          <td>${dist.max}</td>
          <td>${dist.mean}</td>
          <td>${dist.sd}</td>
        </tr>`;
      });
    });

    // Energy bar
    const emDist = summarizeDistribution(sims.energy_max);
    const evDist = summarizeDistribution(sims.energy_value);
    html += `<tr class="est-row-group-start">
      <td>Energy bar</td><td>max</td><td>${emDist.min}</td><td>${emDist.max}</td><td>${emDist.mean}</td><td>${emDist.sd}</td>
    </tr>`;
    html += `<tr class="est-row-group-mid">
      <td></td><td>value</td><td>${evDist.min}</td><td>${evDist.max}</td><td>${evDist.mean}</td><td>${evDist.sd}</td>
    </tr>`;

    body.innerHTML = html;
    console.log(`[estimator] ${(performance.now() - t0).toFixed(1)}ms for ${runs} runs`);
  }, 0));
}

function copyParentAToB() {
  for (let i = 0; i < STATS.length; i++) {
    const safe = STATS[i].toLowerCase().replace(/\s+/g, '-');
    document.getElementById(`est-b-${safe}-val`).value = document.getElementById(`est-a-${safe}-val`).value;
    document.getElementById(`est-b-${safe}-lim`).value = document.getElementById(`est-a-${safe}-lim`).value;
    document.getElementById(`est-b-${safe}-max`).value = document.getElementById(`est-a-${safe}-max`).value;
  }
  document.getElementById('est-b-energy-val').value = document.getElementById('est-a-energy-val').value;
  document.getElementById('est-b-energy-max').value = document.getElementById('est-a-energy-max').value;
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

// ─── Import helpers ───────────────────────────────────────────────────────────

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

async function readClipboardOrPrompt() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch {}
  if (!text) text = window.prompt('Paste your horse JSON here:') ?? '';
  return text.trim();
}

function parseHorseJson(text) {
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error('Import failed: pasted text is not valid JSON.');
  }

  if (data?.type && typeof data.type !== 'string') {
    throw new Error('Invalid format: "type" must be a string when provided.');
  }

  const s = data?.stats;
  if (!s || typeof s !== 'object') {
    throw new Error('Invalid format: missing "stats" object.');
  }

  for (let i = 0; i < STATS.length; i++) {
    const entry = s[STATS[i]] ?? s[statKeyMap[STATS[i]]];
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Invalid format: missing stat "${STATS[i]}".`);
    }
    const hasLegacyShape = 'Level' in entry && 'Limit' in entry && 'Max' in entry;
    const hasHorseShape = 'value' in entry && 'limit' in entry && 'maxValue' in entry;
    if (!hasLegacyShape && !hasHorseShape) {
      throw new Error(`Invalid format: stat "${STATS[i]}" missing value/limit/maxValue.`);
    }
  }

  const parsed = { name: typeof data?.name === 'string' ? data.name.trim() : '', type: typeof data?.type === 'string' ? data.type : '' };
  for (let i = 0; i < STATS.length; i++) {
    const entry = s[STATS[i]] ?? s[statKeyMap[STATS[i]]];
    parsed[`cur-${i}`] = entry.Level ?? entry.value ?? 0;
    parsed[`lim-${i}`] = entry.Limit ?? entry.limit ?? 0;
    parsed[`max-${i}`] = entry.Max ?? entry.maxValue ?? 0;
  }

  // Energy bar (best-effort)
  parsed.energy_value = data?.energy_value ?? data?.energy?.value ?? null;
  parsed.energy_max   = data?.energy_max   ?? data?.energy?.max   ?? null;

  return parsed;
}

// ─── Import: Feeding Calculator ───────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
async function importFromClipboard() {
  const text = await readClipboardOrPrompt();
  if (!text) return;

  let parsed;
  try { parsed = parseHorseJson(text); } catch (e) {
    alert(e.message);
    return;
  }

  for (let i = 0; i < STATS.length; i++) {
    document.getElementById(`cur-${i}`).value = parsed[`cur-${i}`];
    document.getElementById(`lim-${i}`).value = parsed[`lim-${i}`];
    document.getElementById(`max-${i}`).value = parsed[`max-${i}`];
  }

  _lastImportedName = parsed.name;
  _lastImportedType = parsed.type;
  updateDerived();
  runSolver();
}

// ─── Import: Breeding Estimator ───────────────────────────────────────────────

async function importToEstimator(prefix) {
  const text = await readClipboardOrPrompt();
  if (!text) return;

  let parsed;
  try { parsed = parseHorseJson(text); } catch (e) {
    alert(e.message);
    return;
  }

  for (let i = 0; i < STATS.length; i++) {
    const safe = STATS[i].toLowerCase().replace(/\s+/g, '-');
    document.getElementById(`est-${prefix}-${safe}-val`).value = parsed[`cur-${i}`];
    document.getElementById(`est-${prefix}-${safe}-lim`).value = parsed[`lim-${i}`];
    document.getElementById(`est-${prefix}-${safe}-max`).value = parsed[`max-${i}`];
  }

  if (parsed.energy_value != null) {
    document.getElementById(`est-${prefix}-energy-val`).value = parsed.energy_value;
  }
  if (parsed.energy_max != null) {
    document.getElementById(`est-${prefix}-energy-max`).value = parsed.energy_max;
  }
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

// ─── Estimator event listeners ────────────────────────────────────────────────

document.getElementById('btn-simulate').addEventListener('click', runEstimator);
document.getElementById('btn-copy-a-to-b').addEventListener('click', copyParentAToB);

document.querySelectorAll('.btn-est-import').forEach(btn => {
  btn.addEventListener('click', () => importToEstimator(btn.dataset.parent));
});

// ─── Tabs ─────────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).style.display = 'block';
    if (btn.dataset.tab === 'breeding') {
      // Estimator runs on-demand via Simulate button
    }
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

// ─── Saved mounts panel event listeners ───────────────────────────────────────

function showNewSaveForm() {
  const sidebar = document.getElementById('sidebar');
  const existing = sidebar.querySelector('.new-save-form');
  if (existing) { existing.querySelector('input').focus(); return; }

  const form = document.createElement('div');
  form.className = 'new-save-form';
  const pre = _lastImportedName.replace(/"/g, '&quot;');
  form.innerHTML = `
    <input type="text" placeholder="Name this mount…" maxlength="32" value="${pre}">
    <select class="mount-type-select">
      <option value="horse">🐴 Horse</option>
      <option value="wyvern">🐉 Wyvern</option>
      <option value="adasaur">🦖 Adasaur</option>
    </select>
    <div class="new-save-btns">
      <button class="btn-new-save-confirm">Save</button>
      <button class="btn-new-save-cancel">✕</button>
    </div>
  `;
  sidebar.insertBefore(form, sidebar.querySelector('.saved-mounts-columns'));
  const preselectType = (activeMountName && loadMounts()[activeMountName]?.type) || _lastImportedType;
  if (preselectType) form.querySelector('.mount-type-select').value = preselectType;
  const input = form.querySelector('input');
  input.focus();
  input.select();

  const confirm = () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    const type = form.querySelector('.mount-type-select').value;
    saveMountProfile(name, type);
    _lastImportedName = '';
    _lastImportedType = '';
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

document.getElementById('sidebar').addEventListener('click', (e) => {
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

buildEstimatorRows();
loadFromStorage();
renderSavedMounts();
runSolver();
