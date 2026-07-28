// ============================================================
// 38-0 — Anadolu Efes Efsane Kadro Simülasyonu
// ============================================================

const POSITION_ORDER = ["PG", "SG", "SF", "PF", "C"];
const POSITION_LABEL = { PG: "Point Guard (PG)", SG: "Shooting Guard (SG)", SF: "Small Forward (SF)", PF: "Power Forward (PF)", C: "Center (C)" };

const state = {
  budgetType: "unlimited", // "unlimited" | "cap"
  budgetTotal: 100,
  budgetSpent: 0,
  mode: null,
  totalSlots: 0,
  currentSlot: 0,
  openPositions: new Set(),
  openBackupPositions: new Set(),
  roster: [],
  usedPlayerNames: new Set(),
  respinsUsed: 0,
  respinsAllowed: 0,
  currentSpinSeason: null,
  currentSpinPool: [],
  armedPlayer: null,
  coach: null,
  coachRespinsUsed: 0,
  coachRespinsAllowed: 1,
  currentCoachSeason: null,
  currentCoachOptions: [],
  playersBySeason: {},
  coaches: [],
  coachBySeason: {},
  dataReady: false,
};

// ============================================================
// Salary cap pricing
//
// Cost is derived from the same hidden `rating` used by the sim engine (a real,
// research-grounded PIR-like index) via a power-law, not a random number. The
// scale differs by mode because a 100-credit budget has to stretch across only
// 5 players in Starting-5 mode but across 12 in the full-roster mode:
// calibrated so "1 elite player + a full complementary supporting cast" costs
// roughly the full 100 credits in each mode.
// ============================================================
const PRICE_EXPONENT = 1.25;
const PRICE_SCALE = { 5: 1.5, 12: 0.73 };

function getPlayerPrice(player) {
  const scale = PRICE_SCALE[state.mode === "12" ? 12 : 5];
  const r = Math.max(player.rating || 0, 1);
  return Math.max(1, Math.round(scale * Math.pow(r, PRICE_EXPONENT)));
}

function budgetRemaining() {
  return state.budgetTotal - state.budgetSpent;
}

// ============================================================
// Data loading
// ============================================================
async function loadData() {
  const [players, coaches, coachBySeason] = await Promise.all([
    fetch("data/players_by_season.json").then((r) => r.json()),
    fetch("data/coaches.json").then((r) => r.json()),
    fetch("data/coach_by_season.json").then((r) => r.json()),
  ]);
  state.playersBySeason = players;
  state.coaches = coaches;
  state.coachBySeason = coachBySeason;
}

function showDataError(err) {
  const banner = document.createElement("div");
  banner.style.cssText =
    "position:fixed;top:0;left:0;right:0;z-index:999;background:#C1443C;color:#fff;" +
    "padding:14px 20px;font-family:sans-serif;font-size:14px;text-align:center;";
  banner.textContent =
    "Couldn't load the data files (data/*.json). Check the browser console (F12). Error: " + err.message;
  document.body.prepend(banner);
}

// ============================================================
// Screen management
// ============================================================
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ============================================================
// Draft flow
// ============================================================
function startDraft(mode) {
  if (!state.dataReady) {
    alert("Data hasn't loaded yet (or failed to load). Refresh the page and wait a few seconds; if it keeps happening, check the console with F12.");
    return;
  }
  state.mode = mode;
  state.totalSlots = mode === "5" ? 5 : 12;
  state.currentSlot = 0;
  state.openPositions = new Set(POSITION_ORDER);
  state.openBackupPositions = new Set(POSITION_ORDER);
  state.roster = [];
  state.usedPlayerNames = new Set();
  state.armedPlayer = null;
  state.respinsUsed = 0;
  state.respinsAllowed = mode === "5" ? 1 : 3;
  state.budgetSpent = 0;
  document.getElementById("budget-panel").hidden = state.budgetType !== "cap";
  updateBudgetGauge();
  showScreen("screen-draft");
  renderDraftStep();
}

function updateBudgetGauge() {
  if (state.budgetType !== "cap") return;
  const remaining = budgetRemaining();
  const fraction = Math.max(0, remaining / state.budgetTotal);
  const circumference = 263.9;
  const ring = document.getElementById("budget-ring-fg");
  ring.style.strokeDashoffset = String(circumference * (1 - fraction));
  const color = fraction > 0.5 ? "var(--green)" : fraction > 0.2 ? "var(--accent)" : "var(--red)";
  ring.style.stroke = color;
  document.getElementById("budget-remaining").textContent = remaining;
}

function resetToCategory() {
  showScreen("screen-category");
}

// Three tiers for the 12-man mode: starters (0-4, one per position), positional
// backups (5-9, one backup per position), then 2 fully free bench spots (10-11).
// The 5-man mode only ever has the "starter" tier.
function getCurrentTier() {
  if (state.currentSlot < 5) return "starter";
  if (state.mode === "12" && state.currentSlot < 10) return "backup";
  return "free";
}

function isConstrainedPhase() {
  return getCurrentTier() !== "free";
}

function openSetForTier(tier) {
  if (tier === "starter") return state.openPositions;
  if (tier === "backup") return state.openBackupPositions;
  return null;
}

// A player can currently be picked if at least one of their listed positions
// is still open in the current tier (starters/backups) AND (in cap mode) their
// price fits the remaining budget once 1 credit is reserved for every slot
// still to be filled after this pick (so the cap can never dead-end the draft).
// Reserve enough per remaining slot to always afford at least the cheapest
// realistic player for any position (Center's price floor is the highest of
// the five), so a tight cap can never leave a required slot unfillable.
const RESERVE_PER_SLOT = { 5: 7, 12: 4 };

function isPickable(player) {
  if (state.budgetType === "cap") {
    const remainingSlotsAfter = state.totalSlots - state.currentSlot - 1;
    const reserve = remainingSlotsAfter * RESERVE_PER_SLOT[state.mode === "12" ? 12 : 5];
    const spendable = budgetRemaining() - reserve;
    if (getPlayerPrice(player) > spendable) return false;
  }
  const tier = getCurrentTier();
  if (tier === "free") return true;
  return player.positions.some((pos) => openSetForTier(tier).has(pos));
}

// Seasons that have at least one undrafted, currently pickable player.
function eligibleSeasons() {
  const seasons = [];
  for (const [season, list] of Object.entries(state.playersBySeason)) {
    const hasEligible = list.some((p) => !state.usedPlayerNames.has(p.name) && isPickable(p));
    if (hasEligible) seasons.push(season);
  }
  return seasons;
}

function poolForSeason(season) {
  return (state.playersBySeason[season] || []).filter((p) => !state.usedPlayerNames.has(p.name));
}

let poolFilterPosition = "All";
let poolSearchQuery = "";
let poolSortStat = "pts";

function tierLabel(tier) {
  return { starter: "starters", backup: "backups", free: "extra bench" }[tier];
}

function renderDraftStep() {
  const total = state.totalSlots;
  const tier = getCurrentTier();
  state.armedPlayer = null;
  document.getElementById("draft-progress").textContent = `PICK ${state.currentSlot + 1} / ${total}`;
  document.getElementById("draft-slot-label").textContent =
    tier === "free"
      ? "Extra Bench — Free Position"
      : `Open ${tierLabel(tier)} positions: ${POSITION_ORDER.filter((p) => openSetForTier(tier).has(p)).join(" · ")}`;
  updateRespinCounter();
  renderCourt();
  renderBench();
  updateCourtHint();

  document.getElementById("spin-result").hidden = true;
  document.getElementById("pool-controls").hidden = true;
  document.getElementById("player-pool").innerHTML = "";
  document.getElementById("spin-panel").style.display = "block";
}

function updateRespinCounter() {
  const left = state.respinsAllowed - state.respinsUsed;
  document.getElementById("respin-counter").textContent = `Re-spins left: ${left}`;
  document.getElementById("respin-btn").disabled = left <= 0;
}

function updateCourtHint() {
  const hint = document.getElementById("court-hint");
  if (!hint) return;
  const tier = getCurrentTier();
  if (tier === "free") {
    hint.hidden = true;
    return;
  }
  hint.hidden = false;
  if (state.armedPlayer) {
    const openMatches = state.armedPlayer.positions.filter((pos) => openSetForTier(tier).has(pos));
    hint.textContent = `Place ${state.armedPlayer.name} at ${openMatches.join(" / ")} — tap the lit spot.`;
    hint.classList.add("active");
  } else {
    hint.textContent = "Drag a player onto an open spot, or tap a player then tap a lit spot.";
    hint.classList.remove("active");
  }
}

// ---------- Court + Bench: two ways to place a player in a positional slot
// (starters on the court, backups on the bench row):
// (1) drag a card from the pool onto an open slot, or drag an already-placed
//     flex player (e.g. PG/SG) onto their other open slot to move them.
// (2) tap a player card to "arm" it — matching open slots glow — then tap a slot.
let draggedPayload = null; // { mode: "new", player } | { mode: "move", player, fromPos, tier }

function wirePositionalSlot(slotEl, tier) {
  const pos = slotEl.dataset.pos;
  const openSet = openSetForTier(tier);
  const occupant = state.roster.find((p) => p.tier === tier && p.filledPosition === pos);
  slotEl.classList.toggle("filled", !!occupant);
  slotEl.classList.remove("target-glow");
  slotEl.innerHTML = "";
  if (occupant) {
    const nameEl = document.createElement("div");
    nameEl.className = tier === "starter" ? "court-slot-name" : "bench-slot-name";
    nameEl.textContent = occupant.name;
    slotEl.appendChild(nameEl);
    const altPos = occupant.positions.find((p) => p !== pos);
    const canMove = altPos && openSet.has(altPos);
    slotEl.draggable = !!canMove;
    slotEl.ondragstart = canMove
      ? (e) => {
          draggedPayload = { mode: "move", player: occupant, fromPos: pos, tier };
          e.dataTransfer.effectAllowed = "move";
        }
      : null;
  } else {
    slotEl.draggable = false;
    slotEl.ondragstart = null;
    if (getCurrentTier() === tier && state.armedPlayer && state.armedPlayer.positions.includes(pos) && openSet.has(pos)) {
      slotEl.classList.add("target-glow");
    }
  }

  slotEl.onclick = () => {
    if (occupant || getCurrentTier() !== tier || !state.armedPlayer) return;
    if (state.armedPlayer.positions.includes(pos) && openSet.has(pos)) {
      const player = state.armedPlayer;
      state.armedPlayer = null;
      placePlayer(player, pos);
    }
  };

  slotEl.ondragover = (e) => {
    if (!draggedPayload || getCurrentTier() !== tier) return;
    const player = draggedPayload.player;
    const validTarget = !occupant && player.positions.includes(pos) && pos !== draggedPayload.fromPos;
    if (validTarget) {
      e.preventDefault();
      slotEl.classList.add("drag-over");
    } else {
      slotEl.classList.add("drag-invalid");
    }
  };
  slotEl.ondragleave = () => {
    slotEl.classList.remove("drag-over", "drag-invalid");
  };
  slotEl.ondrop = (e) => {
    e.preventDefault();
    slotEl.classList.remove("drag-over", "drag-invalid");
    if (!draggedPayload) return;
    const player = draggedPayload.player;
    if (occupant || !player.positions.includes(pos) || pos === draggedPayload.fromPos) {
      draggedPayload = null;
      return;
    }
    if (draggedPayload.mode === "move") {
      openSet.add(draggedPayload.fromPos);
      openSet.delete(pos);
      player.filledPosition = pos;
      renderCourt();
      renderBench();
      renderDraftStep_labelOnly();
      updateCourtHint();
      if (!document.getElementById("spin-result").hidden) renderPlayerPool(state.currentSpinPool);
    } else if (getCurrentTier() === tier) {
      placePlayer(player, pos);
    }
    draggedPayload = null;
  };
}

function renderCourt() {
  const wrap = document.getElementById("court-wrap");
  const tier = getCurrentTier();
  const showCourt = tier === "starter" || state.roster.some((p) => p.tier === "starter");
  if (!showCourt) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  wrap.querySelectorAll(".court-slot").forEach((slotEl) => wirePositionalSlot(slotEl, "starter"));
}

function renderBench() {
  const wrap = document.getElementById("bench-wrap");
  if (state.mode !== "12") {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  wrap.querySelectorAll("#bench-backup-row .bench-slot").forEach((slotEl) => wirePositionalSlot(slotEl, "backup"));

  document.querySelectorAll("#bench-free-row .bench-slot-free").forEach((slotEl) => {
    const idx = parseInt(slotEl.dataset.index, 10);
    const freePlayers = state.roster.filter((p) => p.tier === "free");
    const occupant = freePlayers[idx];
    slotEl.classList.toggle("filled", !!occupant);
    slotEl.innerHTML = "";
    if (occupant) {
      const nameEl = document.createElement("div");
      nameEl.className = "bench-slot-name";
      nameEl.textContent = occupant.name;
      slotEl.appendChild(nameEl);
    }
    slotEl.ondragover = (e) => {
      if (!draggedPayload || occupant || getCurrentTier() !== "free") return;
      e.preventDefault();
      slotEl.classList.add("drag-over");
    };
    slotEl.ondragleave = () => slotEl.classList.remove("drag-over");
    slotEl.ondrop = (e) => {
      e.preventDefault();
      slotEl.classList.remove("drag-over");
      if (!draggedPayload || occupant || draggedPayload.mode !== "new") return;
      placePlayer(draggedPayload.player, null);
      draggedPayload = null;
    };
  });
}

function renderDraftStep_labelOnly() {
  const tier = getCurrentTier();
  document.getElementById("draft-slot-label").textContent =
    tier === "free"
      ? "Extra Bench — Free Position"
      : `Open ${tierLabel(tier)} positions: ${POSITION_ORDER.filter((p) => openSetForTier(tier).has(p)).join(" · ")}`;
}

function doSpin() {
  const seasons = eligibleSeasons();
  const season = pickRandom(seasons);
  state.currentSpinSeason = season;
  state.currentSpinPool = poolForSeason(season);
  state.armedPlayer = null;
  poolFilterPosition = "All";
  poolSearchQuery = "";
  poolSortStat = "pts";

  document.getElementById("chip-season").textContent = season;
  document.getElementById("spin-result").hidden = false;
  document.getElementById("spin-panel").style.display = "none";
  document.getElementById("pool-controls").hidden = false;
  updateRespinCounter();
  updateCourtHint();

  renderFilterTabs();
  renderSortTabs();
  document.getElementById("player-search").value = "";
  renderPlayerPool(state.currentSpinPool);
}

function respin() {
  if (state.respinsAllowed - state.respinsUsed <= 0) return;
  state.respinsUsed++;
  doSpin();
}

function renderFilterTabs() {
  const container = document.getElementById("pos-filter-tabs");
  container.innerHTML = "";
  const tabs = ["All", ...POSITION_ORDER];
  tabs.forEach((tab) => {
    const btn = document.createElement("button");
    btn.className = "pos-tab" + (tab === poolFilterPosition ? " active" : "");
    btn.textContent = tab;
    btn.addEventListener("click", () => {
      poolFilterPosition = tab;
      renderFilterTabs();
      renderPlayerPool(state.currentSpinPool);
    });
    container.appendChild(btn);
  });
}

const SORT_STATS = ["pts", "reb", "ast", "blk", "stl"];
const SORT_STAT_LABEL = { pts: "PTS", reb: "REB", ast: "AST", blk: "BLK", stl: "STL" };

function renderSortTabs() {
  const container = document.getElementById("sort-tabs");
  if (!container) return;
  container.innerHTML = "";
  const label = document.createElement("span");
  label.className = "sort-tabs-label";
  label.textContent = "Sort by:";
  container.appendChild(label);
  SORT_STATS.forEach((stat) => {
    const btn = document.createElement("button");
    btn.className = "pos-tab" + (stat === poolSortStat ? " active" : "");
    btn.textContent = SORT_STAT_LABEL[stat];
    btn.addEventListener("click", () => {
      poolSortStat = stat;
      renderSortTabs();
      renderPlayerPool(state.currentSpinPool);
    });
    container.appendChild(btn);
  });
}

// blk/stl only exist in the EuroLeague block; a player with no EuroLeague data
// for that stat sorts to the bottom rather than being treated as a zero.
function statValue(p, stat) {
  if (p.euroleague && p.euroleague[stat] != null) return p.euroleague[stat];
  if (p.bsl && (stat === "pts" || stat === "reb" || stat === "ast" || stat === "stl") && p.bsl[stat] != null) return p.bsl[stat];
  return -1;
}

function filteredPool(pool) {
  const filtered = pool.filter((p) => {
    if (poolFilterPosition !== "All" && !p.positions.includes(poolFilterPosition)) return false;
    if (poolSearchQuery && !p.name.toLowerCase().includes(poolSearchQuery.toLowerCase())) return false;
    return true;
  });
  return filtered.sort((a, b) => statValue(b, poolSortStat) - statValue(a, poolSortStat));
}


function buildStatBlocksHtml(p) {
  let html = "";
  if (p.euroleague) {
    const e = p.euroleague;
    html += `
      <div class="stat-block">
        <div class="stat-block-label">EuroLeague</div>
        <div class="stat-row">
          <div><b>${e.pts.toFixed(1)}</b><span>PTS</span></div>
          <div><b>${e.reb.toFixed(1)}</b><span>REB</span></div>
          <div><b>${e.ast.toFixed(1)}</b><span>AST</span></div>
          <div><b>${e.blk.toFixed(1)}</b><span>BLK</span></div>
          <div><b>${e.stl.toFixed(1)}</b><span>STL</span></div>
        </div>
      </div>`;
  }
  if (p.bsl) {
    const b = p.bsl;
    html += `
      <div class="stat-block">
        <div class="stat-block-label">BSL</div>
        <div class="stat-row">
          <div><b>${b.pts.toFixed(1)}</b><span>PTS</span></div>
          <div><b>${b.reb.toFixed(1)}</b><span>REB</span></div>
          <div><b>${b.ast.toFixed(1)}</b><span>AST</span></div>
          <div><b>${(b.stl != null ? b.stl : 0).toFixed(1)}</b><span>STL</span></div>
        </div>
        <div class="no-data-note">BSL source has no blocks data</div>
      </div>`;
  }
  return html;
}

function renderPlayerPool(pool) {
  const container = document.getElementById("player-pool");
  container.innerHTML = "";
  const visible = filteredPool(pool);
  visible.forEach((p) => {
    const tier = getCurrentTier();
    const openMatches = isConstrainedPhase() ? p.positions.filter((pos) => openSetForTier(tier).has(pos)) : [];
    const price = state.budgetType === "cap" ? getPlayerPrice(p) : 0;
    const remainingSlotsAfter = state.totalSlots - state.currentSlot - 1;
    const reserve = remainingSlotsAfter * RESERVE_PER_SLOT[state.mode === "12" ? 12 : 5];
    const affordable = state.budgetType !== "cap" || price <= budgetRemaining() - reserve;
    const pickable = isPickable(p);
    const isArmed = state.armedPlayer === p;

    const card = document.createElement("div");
    card.className = "player-card" + (pickable ? "" : " player-card-disabled") + (isArmed ? " selected" : "");

    const blocksHtml = buildStatBlocksHtml(p);
    const priceTagHtml =
      state.budgetType === "cap"
        ? `<span class="player-price-tag${affordable ? "" : " unaffordable"}">${price}cr</span>`
        : "";

    card.innerHTML = `
      <div class="position-badge">${p.positions.join(" / ")}</div>${priceTagHtml}
      <div class="player-name">${p.name}</div>
      <div class="player-meta">${state.currentSpinSeason}${isConstrainedPhase() ? ` · <span class="open-line">${openMatches.length ? "OPEN: " + openMatches.join(" / ") : "position filled"}</span>` : ""}</div>
      ${blocksHtml}
    `;

    if (pickable) {
      card.draggable = true;
      card.addEventListener("dragstart", (e) => {
        draggedPayload = { mode: "new", player: p };
        e.dataTransfer.effectAllowed = "move";
      });
      card.addEventListener("dragend", () => {
        draggedPayload = null;
        document.querySelectorAll(".court-slot, .bench-slot").forEach((s) => s.classList.remove("drag-over", "drag-invalid"));
      });

      card.addEventListener("click", () => {
        if (!isConstrainedPhase()) {
          // Free bench picks have no position to choose — placing is immediate.
          placePlayer(p, null);
          return;
        }
        // Toggle: clicking the already-armed player disarms it.
        state.armedPlayer = state.armedPlayer === p ? null : p;
        renderPlayerPool(pool);
        renderCourt();
        renderBench();
        updateCourtHint();
      });
    }

    container.appendChild(card);
  });
}

function placePlayer(player, filledPosition) {
  const tier = getCurrentTier();
  if (tier !== "free") {
    openSetForTier(tier).delete(filledPosition);
  }
  if (state.budgetType === "cap") {
    state.budgetSpent += getPlayerPrice(player);
    updateBudgetGauge();
  }

  state.roster.push({
    ...player,
    season: state.currentSpinSeason,
    filledPosition,
    tier,
  });
  state.usedPlayerNames.add(player.name);
  state.armedPlayer = null;

  state.currentSlot++;
  if (state.currentSlot >= state.totalSlots) {
    renderRosterScreen();
  } else {
    renderDraftStep();
  }
}

// ============================================================
// Roster review
// ============================================================
const TIER_ORDER = { starter: 0, backup: 1, free: 2 };

function sortedRoster() {
  return [...state.roster].sort((a, b) => {
    const tierDiff = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (tierDiff !== 0) return tierDiff;
    const posA = a.filledPosition ? POSITION_ORDER.indexOf(a.filledPosition) : POSITION_ORDER.length;
    const posB = b.filledPosition ? POSITION_ORDER.indexOf(b.filledPosition) : POSITION_ORDER.length;
    return posA - posB;
  });
}

function renderRosterCards(containerId, coachBannerId) {
  const grid = document.getElementById(containerId);
  grid.innerHTML = "";
  sortedRoster().forEach((p) => {
    const tag = p.tier === "backup" ? `Backup ${p.filledPosition}` : p.tier === "free" ? "Bench" : p.filledPosition;
    const card = document.createElement("div");
    card.className = "roster-card";
    card.innerHTML = `
      <div class="roster-slot-tag">${tag}</div>
      <div class="player-name">${p.name}</div>
      <div class="player-meta">${p.season}</div>
      ${buildStatBlocksHtml(p)}
    `;
    grid.appendChild(card);
  });

  if (coachBannerId) {
    const banner = document.getElementById(coachBannerId);
    if (banner) {
      banner.textContent = state.coach ? `Head Coach: ${state.coach.name}` : "";
      banner.hidden = !state.coach;
    }
  }
}

function renderRosterScreen() {
  showScreen("screen-roster");
  renderRosterCards("roster-grid", null);
}

function renderSimRoster() {
  renderRosterCards("sim-roster-grid", "sim-coach-banner");
}

// ============================================================
// Coach selection (also a season-spin)
// ============================================================
function coachEligibleSeasons() {
  return Object.keys(state.coachBySeason);
}

function renderCoachStep() {
  document.getElementById("coach-spin-result").hidden = true;
  document.getElementById("coach-grid").innerHTML = "";
  document.getElementById("coach-spin-panel").style.display = "block";
  updateCoachRespinCounter();
}

function updateCoachRespinCounter() {
  const left = state.coachRespinsAllowed - state.coachRespinsUsed;
  document.getElementById("coach-respin-counter").textContent = `Re-spins left: ${left}`;
  document.getElementById("coach-respin-btn").disabled = left <= 0;
}

function doCoachSpin() {
  const seasons = coachEligibleSeasons();
  const season = pickRandom(seasons);
  state.currentCoachSeason = season;
  const names = state.coachBySeason[season];
  state.currentCoachOptions = state.coaches.filter((c) => names.includes(c.name));

  document.getElementById("chip-coach-season").textContent = season;
  document.getElementById("coach-spin-result").hidden = false;
  document.getElementById("coach-spin-panel").style.display = "none";
  updateCoachRespinCounter();

  renderCoachOptions();
}

function coachRespin() {
  if (state.coachRespinsAllowed - state.coachRespinsUsed <= 0) return;
  state.coachRespinsUsed++;
  doCoachSpin();
}

function teamStyleProfile() {
  const totalPts = state.roster.reduce((s, p) => s + (p.euroleague ? p.euroleague.pts : p.bsl ? p.bsl.pts : 0), 0);
  const totalAst = state.roster.reduce((s, p) => s + (p.euroleague ? p.euroleague.ast : p.bsl ? p.bsl.ast : 0), 0);
  const totalReb = state.roster.reduce((s, p) => s + (p.euroleague ? p.euroleague.reb : p.bsl ? p.bsl.reb : 0), 0);
  const astRatio = totalAst / (totalPts || 1);
  const rebRatio = totalReb / (totalPts || 1);
  if (astRatio > 0.28) return "offense";
  if (rebRatio > 0.55) return "defense";
  return "balanced";
}

function renderCoachOptions() {
  const grid = document.getElementById("coach-grid");
  grid.innerHTML = "";
  const teamStyle = teamStyleProfile();
  const toSimBtn = document.getElementById("to-sim-btn");
  toSimBtn.disabled = true;

  state.currentCoachOptions.forEach((c) => {
    const fit = c.style === teamStyle ? 0.05 : c.style === "balanced" || teamStyle === "balanced" ? 0.02 : 0;
    const card = document.createElement("div");
    card.className = "coach-card";
    card.innerHTML = `
      <div class="coach-name">${c.name}</div>
      <div class="coach-years">${c.seasons.join(", ")}</div>
    `;
    card.addEventListener("click", () => {
      document.querySelectorAll(".coach-card").forEach((el) => el.classList.remove("selected"));
      card.classList.add("selected");
      state.coach = { ...c, fitBonus: fit };
      toSimBtn.disabled = false;
    });
    grid.appendChild(card);
  });
}

// ============================================================
// Simulation engine
//
// Grounded in real EuroLeague team data rather than an arbitrary abstract score:
// - LEAGUE_AVG_PPG (80) and LEAGUE_AVG_RATING (7.9) come from real EuroLeague
//   standings (e.g. 2016-17: teams ranged ~78-87 PPG) and from the median PIR-like
//   rating across our own scraped player-season dataset.
// - Team quality is converted into an estimated points-for / points-against split,
//   then run through the basketball Pythagorean win-expectation formula
//   (win% = PF^14 / (PF^14 + PA^14)), the standard real-analytics method for
//   translating scoring differential into expected win rate (same idea used for
//   NBA/EuroLeague team projections). This replaces the earlier logistic curve,
//   which had no real-world anchor.
// - The season is then simulated as 38 independent games at that win probability,
//   so randomness (upsets, streaks) comes from real Bernoulli variance rather than
//   a hand-tuned noise term.
// ============================================================
const LEAGUE_AVG_PPG = 80;
const LEAGUE_AVG_RATING = 7.9;
const PYTHAG_EXPONENT = 14;

function playerRating(p) {
  return p.rating || 0;
}

// Estimated average scoring margin per game against a league-average opponent.
function computeExpectedMargin() {
  const starters = state.roster.slice(0, 5);
  const bench = state.roster.slice(5);

  const avgStarterRating = starters.reduce((s, p) => s + playerRating(p), 0) / starters.length;
  const starterDiff = avgStarterRating - LEAGUE_AVG_RATING;

  let benchDiff = 0;
  if (bench.length > 0) {
    const avgBenchRating = bench.reduce((s, p) => s + playerRating(p), 0) / bench.length;
    benchDiff = avgBenchRating - LEAGUE_AVG_RATING;
  }

  const coach = state.coach;
  const coachPoints = coach.rating * 20 + coach.fitBonus * 10 + (coach.stability || 0) * 10;

  return starterDiff * 1.0 + benchDiff * 0.3 + coachPoints;
}

function pythagoreanWinPct(margin) {
  const pf = LEAGUE_AVG_PPG + margin / 2;
  const pa = LEAGUE_AVG_PPG - margin / 2;
  const pfP = Math.pow(Math.max(pf, 1), PYTHAG_EXPONENT);
  const paP = Math.pow(Math.max(pa, 1), PYTHAG_EXPONENT);
  return pfP / (pfP + paP);
}

function runSimulation() {
  const margin = computeExpectedMargin();
  const winPct = pythagoreanWinPct(margin);

  const results = [];
  for (let i = 0; i < 38; i++) {
    results.push(Math.random() < winPct ? "W" : "L");
  }

  const wins = results.filter((r) => r === "W").length;
  const losses = 38 - wins;

  return { avgP: winPct, results, wins, losses };
}

function animateScoreboard(results, onDone) {
  const track = document.getElementById("scoreboard-track");
  track.innerHTML = "";
  const cells = [];
  for (let i = 0; i < 38; i++) {
    const cell = document.createElement("div");
    cell.className = "flip-cell";
    cell.textContent = i + 1;
    track.appendChild(cell);
    cells.push(cell);
  }
  let i = 0;
  const interval = setInterval(() => {
    if (i >= results.length) {
      clearInterval(interval);
      onDone();
      return;
    }
    cells[i].textContent = results[i];
    cells[i].classList.add(results[i] === "W" ? "win" : "loss");
    i++;
  }, 90);
}

function letterGrade(wins) {
  const pct = wins / 38;
  if (pct >= 1) return "S+";
  if (pct >= 0.92) return "S";
  if (pct >= 0.84) return "A";
  if (pct >= 0.74) return "B";
  if (pct >= 0.6) return "C";
  if (pct >= 0.45) return "D";
  return "F";
}

function verdictText(wins, losses) {
  if (losses === 0) return "THE IMPOSSIBLE JUST HAPPENED. No real team has ever done this — you just did.";
  if (losses === 1) return "That close to perfect is legendary in itself. One game short of 38-0.";
  if (losses <= 3) return "A phenomenal season — the kind that goes down in history.";
  if (losses <= 8) return "A strong roster, but staying perfect every single night is brutal.";
  if (wins >= losses) return "Balanced, but missing that extra edge — bolder picks were needed.";
  return "The roster wasn't coherent enough — depth and coach fit dragged the team down.";
}

// ============================================================
// Wire up events
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".mode-card[data-budget]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.budgetType = btn.dataset.budget;
      showScreen("screen-mode");
    });
  });

  document.querySelectorAll(".mode-card[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => startDraft(btn.dataset.mode));
  });

  document.getElementById("topbar-home-btn").addEventListener("click", () => {
    resetToCategory();
  });
  document.getElementById("topbar-restart-btn").addEventListener("click", () => {
    resetToCategory();
  });

  document.getElementById("spin-btn").addEventListener("click", doSpin);
  document.getElementById("respin-btn").addEventListener("click", respin);
  document.getElementById("player-search").addEventListener("input", (e) => {
    poolSearchQuery = e.target.value;
    renderPlayerPool(state.currentSpinPool);
  });

  document.getElementById("to-coach-btn").addEventListener("click", () => {
    showScreen("screen-coach");
    renderCoachStep();
  });

  document.getElementById("coach-spin-btn").addEventListener("click", doCoachSpin);
  document.getElementById("coach-respin-btn").addEventListener("click", coachRespin);

  document.getElementById("to-sim-btn").addEventListener("click", () => {
    showScreen("screen-sim");
    renderSimRoster();
    document.getElementById("scoreboard-track").innerHTML = "";
    document.getElementById("final-record").hidden = true;
    document.getElementById("restart-btn").hidden = true;
    document.getElementById("sim-btn").hidden = false;
  });

  document.getElementById("sim-btn").addEventListener("click", () => {
    document.getElementById("sim-btn").hidden = true;
    const { results, wins, losses } = runSimulation();
    animateScoreboard(results, () => {
      const finalEl = document.getElementById("final-record");
      finalEl.hidden = false;
      finalEl.innerHTML = `
        <div class="big-record">${wins}–${losses}</div>
        <div class="grade-strip">GRADE: ${letterGrade(wins)}</div>
        <div class="verdict">${verdictText(wins, losses)}</div>
      `;
      document.getElementById("restart-btn").hidden = false;
    });
  });

  document.getElementById("restart-btn").addEventListener("click", () => {
    resetToCategory();
  });

  loadData()
    .then(() => {
      state.dataReady = true;
    })
    .catch((err) => {
      console.error("Failed to load data:", err);
      showDataError(err);
    });
});
