// ============================================================
// Road to Glory — Anadolu Efes All-Time Lineup
// ============================================================

const APP_VERSION = "v19";

const POSITION_ORDER = ["PG", "SG", "SF", "PF", "C"];
const POSITION_LABEL = { PG: "Point Guard (PG)", SG: "Shooting Guard (SG)", SF: "Small Forward (SF)", PF: "Power Forward (PF)", C: "Center (C)" };

const state = {
  budgetType: "unlimited", // "unlimited" | "cap"
  challenge: "none",
  career: null,
  lockedDecade: null,
  teams: [],
  standings: [],
  captainName: null,
  tradeMode: false,
  tradeUsed: false,
  lockedSeasons: [],
  lastPlacedName: null,
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
// research-grounded PIR-like index) via a single power-law — every player has
// ONE true price regardless of mode. What changes between modes is the total
// budget, which scales with roster size (12 players to fill needs more total
// credits than 5), not the per-player price itself.
//
// Note on tuning: a player who always grabs the single best affordable option
// will always spend right up to the edge of what's safe (that's inherent to
// any real salary-cap system, fantasy sports included — it's not a bug). What
// this curve controls is how far the budget stretches for that strategy: a
// flatter exponent makes elite players cost proportionally less, so even a
// value-maximizing draft leaves the roster meaningfully stronger, and the
// reserve floor is generous enough that forced late picks are never scrubs.
// ============================================================
const PRICE_EXPONENT = 1.15;
const PRICE_SCALE = 1.3;
const BUDGET_TOTAL = { 5: 120, 12: 280 };
const RESERVE_PER_SLOT = { 5: 9, 12: 5 };

function getPlayerPrice(player) {
  const r = Math.max(player.rating || 0, 1);
  return Math.max(1, Math.round(PRICE_SCALE * Math.pow(r, PRICE_EXPONENT)));
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
  await loadTeams();
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
  state.budgetTotal = BUDGET_TOTAL[mode === "12" ? 12 : 5];
  state.currentSlot = 0;
  state.openPositions = new Set(POSITION_ORDER);
  state.openBackupPositions = new Set(POSITION_ORDER);
  state.roster = [];
  state.usedPlayerNames = new Set();
  state.armedPlayer = null;
  state.respinsUsed = 0;
  state.respinsAllowed = mode === "5" ? 1 : 3;
  state.captainName = null;
  state.tradeMode = false;
  state.tradeUsed = false;
  state.lockedSeasons = [];
  state.lockedDecade = null;
  state.budgetSpent = 0;
  document.getElementById("budget-panel").hidden = state.budgetType !== "cap";
  document.getElementById("budget-panel-sub").textContent = `Credits remaining out of ${state.budgetTotal}`;
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

// A player can currently be picked if (in cap mode) their price fits the
// remaining budget once enough credits are reserved for every slot still to
// be filled after this pick (so the cap can never dead-end the draft), and —
// only during the starter tier — at least one of their listed positions is
// still open. Backup and free-bench slots accept anyone: the 5 backup slots
// are labeled by position for bench organization, but any player can fill
// any of them, matching real fantasy-roster flexibility.
function isPickable(player) {
  if (state.budgetType === "cap") {
    const remainingSlotsAfter = state.totalSlots - state.currentSlot - 1;
    const reserve = remainingSlotsAfter * RESERVE_PER_SLOT[state.mode === "12" ? 12 : 5];
    const spendable = budgetRemaining() - reserve;
    if (getPlayerPrice(player) > spendable) return false;
  }
  if (!passesChallenge(player, state.currentSpinSeason)) return false;
  const tier = getCurrentTier();
  if (tier !== "starter") return true;
  return player.positions.some((pos) => openSetForTier(tier).has(pos));
}

// Seasons that have at least one undrafted, currently pickable player.
function eligibleSeasons() {
  const seasons = [];
  for (const [season, list] of Object.entries(state.playersBySeason)) {
    if (state.lockedSeasons.includes(season)) continue;
    const hasEligible = list.some((p) => !state.usedPlayerNames.has(p.name) && isPickable(p));
    if (hasEligible) seasons.push(season);
  }
  return seasons;
}

function poolForSeason(season) {
  return (state.playersBySeason[season] || []).filter((p) => {
    if (state.usedPlayerNames.has(p.name)) return false;
    // Challenge filters remove players from the pool entirely rather than
    // showing them as unclickable — a screen full of dead cards is worse UX.
    if (state.challenge === "homegrown" && p.countryCode !== "TR") return false;
    if (state.challenge === "noLegends" && computeLegendSet().has(p.name)) return false;
    return true;
  });
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
  renderMobileLineupStrip();
  updatePlaceBar();

  document.getElementById("spin-result").hidden = true;
  document.getElementById("spin-anim").hidden = true;
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
    const openMatches =
      tier === "starter"
        ? state.armedPlayer.positions.filter((pos) => openSetForTier(tier).has(pos))
        : [...openSetForTier(tier)];
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
  const positionless = tier !== "starter"; // backups/free: any player can fill any open slot
  const occupant = state.roster.find((p) => p.tier === tier && p.filledPosition === pos);
  slotEl.classList.toggle("filled", !!occupant);
  slotEl.classList.remove("target-glow");
  slotEl.innerHTML = "";
  if (occupant) {
    const nameEl = document.createElement("div");
    nameEl.className = tier === "starter" ? "court-slot-name" : "bench-slot-name";
    nameEl.textContent = occupant.name;
    slotEl.appendChild(nameEl);
    if (occupant.name === state.lastPlacedName) {
      slotEl.classList.add("just-placed");
      setTimeout(() => slotEl.classList.remove("just-placed"), 500);
    }
    const altPos = occupant.positions.find((p) => p !== pos);
    const canMove = positionless ? [...openSet].some((p) => p !== pos) : altPos && openSet.has(altPos);
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
    const fits = state.armedPlayer && (positionless || state.armedPlayer.positions.includes(pos));
    if (getCurrentTier() === tier && fits && openSet.has(pos)) {
      slotEl.classList.add("target-glow");
    }
  }

  slotEl.onclick = () => {
    if (occupant || getCurrentTier() !== tier || !state.armedPlayer) return;
    const fits = positionless || state.armedPlayer.positions.includes(pos);
    if (fits && openSet.has(pos)) {
      const player = state.armedPlayer;
      state.armedPlayer = null;
      placePlayer(player, pos);
    }
  };

  slotEl.ondragover = (e) => {
    if (!draggedPayload || getCurrentTier() !== tier) return;
    const player = draggedPayload.player;
    const fits = positionless || player.positions.includes(pos);
    const validTarget = !occupant && fits && pos !== draggedPayload.fromPos;
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
    const fits = positionless || player.positions.includes(pos);
    if (occupant || !fits || pos === draggedPayload.fromPos) {
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
  // One Decade: the very first spin picks the decade, and every later spin is
  // confined to it. This also prevents the old dead-end where a second spin
  // landed on a different decade and left nothing selectable.
  if (state.challenge === "singleEra" && state.lockedDecade == null) {
    spinDecadeThenSeason();
    return;
  }
  const seasons = eligibleSeasons();
  const season = pickRandom(seasons);

  document.getElementById("spin-panel").style.display = "none";
  document.getElementById("spin-result").hidden = true;
  document.getElementById("pool-controls").hidden = true;
  document.getElementById("player-pool").innerHTML = "";

  const animEl = document.getElementById("spin-anim");
  const labelEl = document.getElementById("spin-anim-label");
  animEl.hidden = false;
  let shuffleCount = 0;
  const shuffleInterval = setInterval(() => {
    labelEl.textContent = pickRandom(seasons);
    shuffleCount++;
  }, 80);

  setTimeout(() => {
    clearInterval(shuffleInterval);
    animEl.hidden = true;

    state.currentSpinSeason = season;
    state.currentSpinPool = poolForSeason(season);
    state.armedPlayer = null;
    poolFilterPosition = "All";
    poolSearchQuery = "";
    poolSortStat = "pts";

    document.getElementById("chip-season").innerHTML = season + seasonNoteHtml(season);
    document.getElementById("spin-result").hidden = false;
    document.getElementById("pool-controls").hidden = false;
    updateRespinCounter();
    updateCourtHint();

    renderFilterTabs();
    renderSortTabs();
    document.getElementById("player-search").value = "";
    renderPlayerPool(state.currentSpinPool);
  }, 700);
}

function respin() {
  if (state.respinsAllowed - state.respinsUsed <= 0) return;
  // Re-spinning burns the season you walked away from: it's locked out for the
  // rest of the draft, so a re-spin is a real commitment rather than a free reroll.
  if (state.currentSpinSeason && !state.lockedSeasons.includes(state.currentSpinSeason)) {
    state.lockedSeasons.push(state.currentSpinSeason);
  }
  state.respinsUsed++;
  renderLockedSeasons();
  doSpin();
}

function renderLockedSeasons() {
  const el = document.getElementById("locked-seasons");
  if (!el) return;
  if (!state.lockedSeasons.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span class="locked-label">Locked out:</span>` +
    state.lockedSeasons.map((s2) => `<span class="locked-chip">🔒 ${s2}</span>`).join("");
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


// A small "jersey" style monogram badge — since we don't have real photos or
// jersey numbers for every historical player, a deterministic colored initials
// badge gives each card a visual anchor without inventing fake data.
const AVATAR_COLORS = ["#00A4D2", "#D73430", "#3F9463", "#8A6A2E", "#5B7FBF", "#B85C3C"];

function initialsOf(name) {
  const parts = name.replace(/['.]/g, "").trim().split(/\s+/);
  const first = parts[0]?.[0] || "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

function hashColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

// Three real Anadolu Efes kit looks: solid navy, solid white, blue/white stripes.
const KITS = ["kit-navy", "kit-white", "kit-striped"];

function avatarHtml(name) {
  const initials = initialsOf(name);
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const kit = KITS[hash % KITS.length];
  return `<div class="player-avatar ${kit}">${initials}</div>`;
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
    const openMatches =
      tier === "starter"
        ? p.positions.filter((pos) => openSetForTier(tier).has(pos))
        : tier === "backup"
        ? [...openSetForTier(tier)]
        : [];
    const price = state.budgetType === "cap" ? getPlayerPrice(p) : 0;
    const remainingSlotsAfter = state.totalSlots - state.currentSlot - 1;
    const reserve = remainingSlotsAfter * RESERVE_PER_SLOT[state.mode === "12" ? 12 : 5];
    const affordable = state.budgetType !== "cap" || price <= budgetRemaining() - reserve;
    const pickable = isPickable(p);
    const isArmed = state.armedPlayer === p;

    const card = document.createElement("div");
    card.className = "player-card era-" + eraClassOf(state.currentSpinSeason) + (pickable ? "" : " player-card-disabled") + (isArmed ? " selected" : "");

    const blocksHtml = buildStatBlocksHtml(p);
    const priceTagHtml =
      state.budgetType === "cap"
        ? `<span class="player-price-tag${affordable ? "" : " unaffordable"}">${price}cr</span>`
        : "";

    card.innerHTML = `
      <div class="card-top-row">
        <div class="position-badge">${p.positions.join(" / ")}</div>${priceTagHtml}
      </div>
      <div class="player-head-row">
        ${avatarHtml(p.name)}
        <div class="player-name">${p.name}</div>
      </div>
      <div class="player-meta">${state.currentSpinSeason}${isConstrainedPhase() ? ` · <span class="open-line">${openMatches.length ? "OPEN: " + openMatches.join(" / ") : "position filled"}</span>` : ""}</div>
      ${bioLineHtml(p)}
      ${honorsHtml(honorsFor(p, state.currentSpinSeason))}
      ${blocksHtml}
      <button class="info-btn" data-player="${p.name}" title="Career detail">i</button>
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
  state.lastPlacedName = player.name;
  SFX.place();
  state.armedPlayer = null;

  state.currentSlot++;
  saveDraftState();
  if (state.currentSlot >= state.totalSlots) {
    clearDraftState();
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
    card.className = "roster-card era-" + eraClassOf(p.season);
    card.innerHTML = `
      <div class="roster-slot-tag">${tag}</div>
      <div class="player-head-row">
        ${avatarHtml(p.name)}
        <div class="player-name">${p.name}</div>
      </div>
      <div class="player-meta">${p.season}</div>
      ${bioLineHtml(p)}
      ${state.captainName === p.name ? '<div class="captain-badge">★ CAPTAIN</div>' : ""}
      ${honorsHtml(honorsFor(p, p.season))}
      ${buildStatBlocksHtml(p)}
    `;
    card.addEventListener("click", () => {
      if (state.tradeMode) executeTrade(p);
      else setCaptain(p.name);
    });
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
  document.getElementById("coach-spin-anim").hidden = true;
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

  document.getElementById("coach-spin-panel").style.display = "none";
  document.getElementById("coach-spin-result").hidden = true;

  const animEl = document.getElementById("coach-spin-anim");
  const labelEl = document.getElementById("coach-spin-anim-label");
  animEl.hidden = false;
  const shuffleInterval = setInterval(() => {
    labelEl.textContent = pickRandom(seasons);
  }, 80);

  setTimeout(() => {
    clearInterval(shuffleInterval);
    animEl.hidden = true;

    state.currentCoachSeason = season;
    const names = state.coachBySeason[season];
    state.currentCoachOptions = state.coaches.filter((c) => names.includes(c.name));

    document.getElementById("chip-coach-season").textContent = season;
    document.getElementById("coach-spin-result").hidden = false;
    updateCoachRespinCounter();

    renderCoachOptions();
  }, 700);
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

// Mode-aware weighting. In Starting-5 mode there is no bench to model, so the
// five starters ARE the team and carry full weight. In 12-man mode the starters
// carry slightly less and the bench contributes the remainder. Without this,
// 12-man was strictly easier (an elite bench added margin that 5-man could
// never earn), making a perfect 38-0 ~4x more likely there. These weights are
// calibrated so a maxed-out roster has roughly the same shot in either mode.
const STARTER_WEIGHT = { 5: 1.25, 12: 1.0 };
const BENCH_WEIGHT = 0.3;

function playerRating(p) {
  return p.rating || 0;
}

// Estimated average scoring margin per game against a league-average opponent.
function computeExpectedMargin() {
  const starters = state.roster.filter((p) => p.tier === "starter");
  const bench = state.roster.filter((p) => p.tier !== "starter");
  const starterWeight = STARTER_WEIGHT[state.mode === "12" ? 12 : 5];

  const captainBoost = (p) => (state.captainName === p.name ? 1.15 : 1);
  const avgStarterRating =
    starters.reduce((s, p) => s + playerRating(p) * captainBoost(p), 0) / (starters.length || 1);
  const starterDiff = avgStarterRating - LEAGUE_AVG_RATING;

  let benchTerm = 0;
  if (bench.length > 0) {
    const avgBenchRating = bench.reduce((s, p) => s + playerRating(p), 0) / bench.length;
    benchTerm = (avgBenchRating - LEAGUE_AVG_RATING) * BENCH_WEIGHT;
  }

  const coach = state.coach;
  const coachPoints = coach.rating * 20 + coach.fitBonus * 10 + (coach.stability || 0) * 10;

  return starterDiff * starterWeight + benchTerm + coachPoints;
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
  const liveEl = document.getElementById("live-record");
  track.innerHTML = "";
  const cells = [];
  for (let i = 0; i < 38; i++) {
    const cell = document.createElement("div");
    cell.className = "flip-cell";
    cell.textContent = i + 1;
    track.appendChild(cell);
    cells.push(cell);
  }

  if (liveEl) {
    liveEl.hidden = false;
    liveEl.innerHTML = `<span class="live-rec">0–0</span><span class="live-streak"></span>`;
  }

  let i = 0, w = 0, l = 0, streak = 0, streakType = null;
  const interval = setInterval(() => {
    if (i >= results.length) {
      clearInterval(interval);
      if (liveEl) liveEl.hidden = true;
      try { drawSeasonChart(results); } catch (e) { console.error("chart failed", e); }
      try { renderMvpAndLeaders(); } catch (e) { console.error("leaders failed", e); }
      onDone();
      return;
    }
    const res = results[i];
    const sc = simGameScore(0, res === "W");
    cells[i].textContent = res;
    cells[i].title = `Game ${i + 1}: ${res} ${sc[0]}–${sc[1]}`;
    cells[i].classList.add(res === "W" ? "win" : "loss");
    cells[i].classList.add("flip-in");
    if (res === "W") SFX.win(); else SFX.loss();

    if (i === 18) {
      const hb = document.getElementById("halftime-banner");
      if (hb) {
        hb.hidden = false;
        hb.textContent = `Halfway mark: ${w}–${l}`;
        setTimeout(() => { hb.hidden = true; }, 700);
      }
    }

    if (res === "W") w++; else l++;
    if (res === streakType) streak++;
    else { streakType = res; streak = 1; }

    if (liveEl) {
      const streakTxt =
        streak >= 3 ? `<span class="live-streak ${streakType === "W" ? "hot" : "cold"}">${streak} ${streakType === "W" ? "WIN" : "LOSS"} STREAK</span>` : "";
      liveEl.innerHTML = `<span class="live-rec">${w}–${l}</span>${streakTxt}`;
    }
    i++;
  }, 330);
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
  if (losses === 1) return "A perfect regular season slipped away by a single night.";
  if (losses <= 3) return "A phenomenal season — the kind that goes down in history.";
  if (losses <= 8) return "A strong roster, but staying perfect every single night is brutal.";
  if (wins >= losses) return "Balanced, but missing that extra edge — bolder picks were needed.";
  return "The roster wasn't coherent enough — depth and coach fit dragged the team down.";
}

function triggerConfetti() {
  const colors = ["#213557", "#F4EFE3", "#00A4D2"];
  const container = document.createElement("div");
  container.className = "confetti-layer";
  document.body.appendChild(container);

  for (let i = 0; i < 60; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = Math.random() * 100 + "vw";
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDuration = 2.2 + Math.random() * 1.6 + "s";
    piece.style.animationDelay = Math.random() * 0.4 + "s";
    piece.style.setProperty("--drift", (Math.random() * 160 - 80) + "px");
    container.appendChild(piece);
  }

  setTimeout(() => container.remove(), 4200);
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
    showScreen("screen-lineup");
    renderLineupIntro();
  });

  document.getElementById("lineup-continue-btn").addEventListener("click", () => {
    SFX.whistle();
    showScreen("screen-sim");
    renderSimRoster();
    document.getElementById("scoreboard-track").innerHTML = "";
    document.getElementById("final-record").hidden = true;
    document.getElementById("season-narrative").hidden = true;
    document.getElementById("result-actions").hidden = true;
    document.getElementById("sim-btn").hidden = false;
  });

  document.getElementById("sim-btn").addEventListener("click", () => {
    document.getElementById("sim-btn").hidden = true;
    const { results, wins, losses } = runSimulation();
    animateScoreboard(results, () => {
      const finalEl = document.getElementById("final-record");
      finalEl.hidden = false;
      finalEl.innerHTML = `
        <div class="big-record" id="big-record">0–0</div>
        <div class="grade-strip">GRADE: ${letterGrade(wins)}</div>
        <div class="verdict">${verdictText(wins, losses)}</div>
      `;
      const narrEl = document.getElementById("season-narrative");
      narrEl.hidden = false;
      narrEl.textContent = buildNarrative(results);

      countUpRecord(wins, losses);
      document.getElementById("result-actions").hidden = false;
      document.getElementById("to-playoffs-btn").hidden = false;
      lastResult = { wins, losses, champion: false };
      lastMargin = computeExpectedMargin();

      saveHistoryEntry({
        wins, losses, champion: false,
        mode: state.mode === "12" ? "12-Man" : "Starting 5",
        budget: state.budgetType === "cap" ? "Salary Cap" : "Unlimited",
        starters: state.roster.filter((p) => p.tier === "starter").map((p) => p.name),
      });
      if (losses === 0) { SFX.crowd(); triggerConfetti(); }
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

// ============================================================
// v11 additions: honors, achievements, narrative, playoffs,
// special challenges, share card
// ============================================================

// ---------- Player honors (derived from real, verifiable club history) ----------
// Only seasons where the club actually won the trophy are marked, so no honor
// is ever invented for a player who didn't earn it.
const EUROLEAGUE_TITLE_SEASONS = ["2020-21", "2021-22"];
const KORAC_TITLE_SEASONS = ["1995-96"];

function honorsFor(player, season) {
  const honors = [];
  if (EUROLEAGUE_TITLE_SEASONS.includes(season)) honors.push("EuroLeague Champion");
  if (KORAC_TITLE_SEASONS.includes(season)) honors.push("Korać Cup Winner");
  return honors;
}

// ---------- Local profile (no account needed — stored in this browser) ----------
const STORE_KEY = "efes380_profile_v1";

function loadProfile() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || { achievements: {}, bestWins: 0, gamesPlayed: 0 };
  } catch {
    return { achievements: {}, bestWins: 0, gamesPlayed: 0 };
  }
}

function saveProfile(profile) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(profile));
  } catch {
    /* storage may be unavailable (private mode) — the game still works, just won't persist */
  }
}

const ACHIEVEMENTS = [
  { id: "perfect", name: "The Impossible", desc: "Go undefeated through the regular season" },
  { id: "near", name: "One Away", desc: "Finish 37–1" },
  { id: "thirty", name: "Thirty Club", desc: "Win 30+ games" },
  { id: "oneseason", name: "Time Capsule", desc: "Build a starting five from a single season" },
  { id: "homegrown", name: "Homegrown", desc: "Win 25+ with a starting five of Turkish players" },
  { id: "thrifty", name: "Bargain Hunter", desc: "Win 30+ using under half the salary cap" },
  { id: "champion", name: "Glory", desc: "Lift the EuroLeague trophy" },
];

// A conservative Turkish-player check: names we can verify from the club's own
// homegrown/Turkish contingent in the dataset.
const TURKISH_MARKERS = /ğ|ş|ı|İ|ç|ö|ü/i;
function looksTurkish(name) {
  return TURKISH_MARKERS.test(name);
}

function evaluateAchievements(wins, playoffWon) {
  const profile = loadProfile();
  const unlocked = [];
  const starters = state.roster.filter((p) => p.tier === "starter");

  function unlock(id) {
    if (!profile.achievements[id]) {
      profile.achievements[id] = new Date().toISOString();
      unlocked.push(ACHIEVEMENTS.find((a) => a.id === id));
    }
  }

  if (wins === 38) unlock("perfect");
  if (wins === 37) unlock("near");
  if (wins >= 30) unlock("thirty");
  if (starters.length === 5 && new Set(starters.map((p) => p.season)).size === 1) unlock("oneseason");
  if (wins >= 25 && starters.length === 5 && starters.every((p) => p.countryCode === "TR")) unlock("homegrown");
  if (wins >= 30 && state.budgetType === "cap" && state.budgetSpent <= state.budgetTotal / 2) unlock("thrifty");
  if (playoffWon) unlock("champion");

  profile.bestWins = Math.max(profile.bestWins || 0, wins);
  profile.gamesPlayed = (profile.gamesPlayed || 0) + 1;
  saveProfile(profile);
  return unlocked;
}

function renderAchievements() {
  const grid = document.getElementById("achv-grid");
  if (!grid) return;
  const profile = loadProfile();
  grid.innerHTML = "";
  ACHIEVEMENTS.forEach((a) => {
    const earned = !!profile.achievements[a.id];
    const el = document.createElement("div");
    el.className = "achv-card" + (earned ? " earned" : "");
    el.innerHTML = `
      <div class="achv-icon">${earned ? "★" : "☆"}</div>
      <div class="achv-text">
        <div class="achv-name">${a.name}</div>
        <div class="achv-desc">${a.desc}</div>
      </div>`;
    grid.appendChild(el);
  });
}

// ---------- Season narrative ----------
function buildNarrative(results) {
  const parts = [];
  let best = 0, bestType = null, cur = 0, curType = null;
  results.forEach((r) => {
    if (r === curType) cur++;
    else { curType = r; cur = 1; }
    if (curType === "W" && cur > best) { best = cur; bestType = "W"; }
  });

  let worst = 0; cur = 0; curType = null;
  results.forEach((r) => {
    if (r === curType) cur++;
    else { curType = r; cur = 1; }
    if (curType === "L" && cur > worst) worst = cur;
  });

  const firstTen = results.slice(0, 10).filter((r) => r === "W").length;
  const lastTen = results.slice(-10).filter((r) => r === "W").length;

  parts.push(`Opened the season ${firstTen}–${10 - firstTen} over the first ten.`);
  if (best >= 5) parts.push(`Ripped off a ${best}-game winning streak along the way.`);
  if (worst >= 3) parts.push(`Hit a rough patch with ${worst} straight losses.`);
  parts.push(`Closed ${lastTen}–${10 - lastTen} down the stretch.`);
  return parts.join(" ");
}

// ---------- Playoffs (real EuroLeague format: QF, SF, Final) ----------
function gaussian() {
  const u = Math.random() || 1e-9, v = Math.random() || 1e-9;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function simGameScore(_p, won) {
  const base = 78 + Math.round(Math.random() * 12);
  const gap = Math.max(1, Math.round(Math.abs(gaussian()) * 7) + 1);
  return won ? [base + gap, base] : [base, base + gap];
}

// Win probability against a specific opponent, using their real-form strength.
function winProbVs(margin, opponent) {
  return pythagoreanWinPct(margin - opponent.strength * 1.45);
}

// Real EuroLeague home pattern for a best-of-five: games 1, 2 and 5 belong to
// the higher-seeded side. Home court is worth roughly a 3-point swing.
const HOME_GAMES_BO5 = [1, 2, 5];
const HOME_EDGE = 3;

function playSeries(margin, opponent, bestOf, userHasHomeCourt) {
  const games = [];
  let w = 0, l = 0;
  const needed = Math.ceil(bestOf / 2);
  while (w < needed && l < needed) {
    const gameNo = games.length + 1;
    let atHome;
    if (bestOf > 1) {
      atHome = userHasHomeCourt ? HOME_GAMES_BO5.includes(gameNo) : !HOME_GAMES_BO5.includes(gameNo);
    } else {
      atHome = !!userHasHomeCourt; // single games are hosted by the better seed
    }
    const p = pythagoreanWinPct(margin - opponent.strength * 1.45 + (atHome ? HOME_EDGE : -HOME_EDGE));
    const won = Math.random() < p;
    games.push({ won, atHome, score: simGameScore(p, won) });
    if (won) w++; else l++;
  }
  return { opponent, games, w, l, won: w >= needed, bestOf, userHasHomeCourt };
}

let lastPlayoffChampion = false;
let lastPlayoffFinish = "";

// Seeds the bracket from the final table: the user meets progressively better
// opposition, drawn from the actual standings rather than fixed placeholders.
function opponentsFromStandings(userRank) {
  const others = state.standings.filter((r) => !r.isUser);
  const qfSeed = Math.max(0, Math.min(others.length - 1, 8 - Math.min(userRank, 6)));
  const top = [...others].sort((a, b) => b.wins - a.wins);
  return {
    qf: others[qfSeed] || top[3],
    sf: top[1] || top[0],
    final: top[0],
    third: top[2] || top[0],
  };
}

function playPlayoffs(regularMargin, userRank) {
  const roundsEl = document.getElementById("playoff-rounds");
  const verdictEl = document.getElementById("playoff-verdict");
  const trophyEl = document.getElementById("trophy-stage");
  const actionsEl = document.getElementById("playoff-actions");
  roundsEl.innerHTML = "";
  verdictEl.textContent = "";
  verdictEl.className = "playoff-verdict";
  trophyEl.hidden = true;
  actionsEl.hidden = true;

  if (userRank > 10) {
    lastPlayoffChampion = false;
    lastPlayoffMedal = null;
    lastPlayoffFinish = "Missed the postseason";
    verdictEl.textContent = "You finished outside the top ten. No postseason this year.";
    actionsEl.hidden = false;
    finishPlayoffs();
    return;
  }

  const opp = opponentsFromStandings(userRank);
  const sequence = [];

  // Play-In Showdown for seeds 7-10, following the real EuroLeague format:
  // 7v8 winner takes the 7th playoff seed; 9v10 loser is out; the 7/8 loser
  // then meets the 9/10 winner for the last playoff spot.
  let survivedPlayIn = true;
  if (userRank >= 7 && userRank <= 10) {
    const playIn = buildPlayIn(regularMargin, userRank);
    sequence.push(...playIn.stages);
    survivedPlayIn = playIn.advanced;
    if (!survivedPlayIn) {
      lastPlayoffChampion = false;
      lastPlayoffMedal = null;
      lastPlayoffFinish = "Knocked out in the Play-In Showdown";
    }
  }

  if (survivedPlayIn) {
  const qf = playSeries(regularMargin, opp.qf, 5, userRank <= 4);
  sequence.push({ title: "Quarterfinal", subtitle: "Best of 5 — first to 3 wins", ...qf });

  if (qf.won) {
    const sf = playSeries(regularMargin, opp.sf, 1, false); // Final Four is neutral
    sequence.push({ title: "Final Four — Semifinal", subtitle: "Single game", ...sf });
    if (sf.won) {
      const fin = playSeries(regularMargin, opp.final, 1, false);
      sequence.push({ title: "Final Four — Final", subtitle: "Single game", ...fin });
      lastPlayoffChampion = fin.won;
      lastPlayoffFinish = fin.won ? "EuroLeague Champions" : "Runners-up";
      lastPlayoffMedal = fin.won ? "gold" : "silver";
    } else {
      const third = playSeries(regularMargin, opp.third, 1, false);
      sequence.push({ title: "Final Four — Third Place Game", subtitle: "Single game", ...third });
      lastPlayoffChampion = false;
      lastPlayoffFinish = third.won ? "Third place" : "Fourth place";
      lastPlayoffMedal = third.won ? "bronze" : null;
    }
  } else {
    lastPlayoffChampion = false;
    lastPlayoffFinish = "Eliminated in the quarterfinals";
    lastPlayoffMedal = null;
  }
  }

  // Reveal round by round, and inside each round game by game — the same
  // beat-by-beat pacing as the regular season rather than a finished block.
  let ri = 0;
  function revealRound() {
    if (ri >= sequence.length) return endPlayoffs();

    const r = sequence[ri];
    const c = r.opponent.colors;
    const el = document.createElement("div");
    el.className = "playoff-round pending";
    const seriesLabel = r.bestOf > 1 ? r.subtitle : r.subtitle;
    el.innerHTML = `
      <div class="pr-name">${r.title}</div>
      <div class="pr-matchup">
        <span class="st-badge" style="background:${c[0]};color:${c[1]}">${r.opponent.short}</span>
        <span class="pr-opp">vs ${r.opponent.name}</span>
      </div>
      <div class="pr-series"><span class="pr-series-label">${seriesLabel}</span> <span class="pr-tally"></span></div>
      <div class="pr-games"></div>
      <div class="pr-res pr-res-pending">PLAYING…</div>`;
    roundsEl.appendChild(el);
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });

    const gamesEl = el.querySelector(".pr-games");
    const tallyEl = el.querySelector(".pr-tally");
    const resEl = el.querySelector(".pr-res");
    let gi = 0, w = 0, l = 0;

    function revealGame() {
      if (gi >= r.games.length) {
        el.classList.remove("pending");
        el.classList.add(r.won ? "won" : "lost");
        resEl.classList.remove("pr-res-pending");
        resEl.textContent = r.won ? "ADVANCED" : "ELIMINATED";
        if (r.won) SFX.win(); else SFX.loss();
        ri++;
        setTimeout(revealRound, 1100);
        return;
      }
      const g = r.games[gi];
      const row = document.createElement("div");
      row.className = `pr-game ${g.won ? "w" : "l"} game-in`;
      row.innerHTML = `<span>Game ${gi + 1} <span class="pr-venue">${g.atHome ? "H" : "A"}</span></span><span>${g.won ? "W" : "L"} ${g.score[0]}–${g.score[1]}</span>`;
      gamesEl.appendChild(row);
      if (g.won) w++; else l++;
      if (r.bestOf > 1) tallyEl.textContent = `· ${w}–${l}`;
      if (g.won) SFX.win(); else SFX.loss();
      gi++;
      setTimeout(revealGame, 850);
    }
    setTimeout(revealGame, 500);
  }

  function endPlayoffs() {
    if (lastPlayoffMedal) {
      trophyEl.hidden = false;
      renderMedal(lastPlayoffMedal);
    }
    if (lastPlayoffChampion) {
      verdictEl.textContent = "The trophy is yours.";
      verdictEl.className = "playoff-verdict champion";
      SFX.crowd();
      triggerConfetti();
    } else {
      verdictEl.textContent = lastPlayoffFinish + ".";
    }
    try { renderBracket(userRank, sequence.some((r) => r.title === "Quarterfinal" && r.won)); } catch (e) { console.error("bracket failed", e); }
    try { renderAwards(); } catch (e) { console.error("awards failed", e); }
    actionsEl.hidden = false;
    finishPlayoffs();
    if (state.career) {
      try { finishCareerSeason(userRank); } catch (e) { console.error("career failed", e); }
    }
  }

  revealRound();
}

let lastPlayoffMedal = null;

// Gold trophy for the title, silver medal for the runner-up, bronze for third.
function renderMedal(kind) {
  const stage = document.getElementById("trophy-stage");
  if (!stage) return;
  const config = {
    gold:   { cls: "medal-gold",   label: "EUROLEAGUE CHAMPIONS" },
    silver: { cls: "medal-silver", label: "RUNNERS-UP" },
    bronze: { cls: "medal-bronze", label: "THIRD PLACE" },
  }[kind];

  const trophySvg = `
    <svg viewBox="0 0 64 64" class="trophy-svg" aria-hidden="true">
      <path d="M20 8h24v14a12 12 0 0 1-24 0z" fill="currentColor"/>
      <path d="M20 12H12a8 8 0 0 0 8 8M44 12h8a8 8 0 0 1-8 8" fill="none" stroke="currentColor" stroke-width="3"/>
      <path d="M30 34h4v10h-4zM22 44h20v5H22z" fill="currentColor"/>
      <path d="M18 49h28v5H18z" fill="currentColor"/>
    </svg>`;

  const medalSvg = `
    <svg viewBox="0 0 64 64" class="trophy-svg" aria-hidden="true">
      <path d="M22 4l8 20h-8L14 6z" fill="currentColor" opacity="0.75"/>
      <path d="M42 4l8 2-8 18h-8z" fill="currentColor" opacity="0.55"/>
      <circle cx="32" cy="42" r="17" fill="currentColor"/>
      <circle cx="32" cy="42" r="12" fill="none" stroke="rgba(0,0,0,0.28)" stroke-width="2"/>
      <path d="M32 34l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z" fill="rgba(0,0,0,0.3)"/>
    </svg>`;

  stage.className = `trophy-stage ${config.cls}`;
  stage.innerHTML = `${kind === "gold" ? trophySvg : medalSvg}<div class="trophy-text">${config.label}</div>`;
}

function finishPlayoffs() {
  if (lastResult) lastResult.champion = lastPlayoffChampion;
  try {
    const unlocked = evaluateAchievements(lastResult ? lastResult.wins : 0, lastPlayoffChampion);
    if (unlocked.length) showAchievementToasts(unlocked);
  } catch (e) {
    console.error("achievements failed", e);
  }
}



// ---------- Special challenge modes ----------
const CHALLENGES = [
  { id: "none", name: "No Restriction", desc: "The standard build." },
  { id: "singleEra", name: "One Decade", desc: "Every pick must come from the same decade." },
  { id: "homegrown", name: "Homegrown Only", desc: "Turkish players only." },
  { id: "noLegends", name: "No Legends", desc: "The 20 best players are off the board." },
];

let legendNameSet = null;
function computeLegendSet() {
  if (legendNameSet) return legendNameSet;
  legendNameSet = new Set(computeLegendIndex().slice(0, 20).map((e) => e.name));
  return legendNameSet;
}

function decadeOf(season) {
  return Math.floor(parseInt(season.split("-")[0], 10) / 10) * 10;
}

// Returns true if this player is allowed under the active challenge.
function passesChallenge(player, season) {
  switch (state.challenge) {
    case "singleEra":
      if (state.lockedDecade == null) return true;
      return decadeOf(season) === state.lockedDecade;
    case "homegrown":
    case "noLegends":
      return true; // already filtered out of the pool
    default:
      return true;
  }
}

function renderChallenges() {
  const grid = document.getElementById("challenge-grid");
  if (!grid) return;
  grid.innerHTML = "";
  CHALLENGES.forEach((c) => {
    const btn = document.createElement("button");
    btn.className = "mode-card challenge-card" + (state.challenge === c.id ? " selected" : "");
    btn.innerHTML = `<span class="mode-name">${c.name}</span><span class="mode-desc">${c.desc}</span>`;
    btn.addEventListener("click", () => {
      state.challenge = c.id;
      renderChallenges();
    });
    grid.appendChild(btn);
  });
}

// ---------- Share card ----------
function drawShareCard(wins, losses, champion) {
  const canvas = document.getElementById("share-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#16294A");
  grad.addColorStop(1, "#0D1B30");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // jersey trim stripe
  ctx.fillStyle = "#D73430"; ctx.fillRect(0, 0, W / 3, 14);
  ctx.fillStyle = "#F4EFE3"; ctx.fillRect(W / 3, 0, W / 3, 14);
  ctx.fillStyle = "#00A4D2"; ctx.fillRect((2 * W) / 3, 0, W / 3, 14);

  ctx.textAlign = "center";
  ctx.fillStyle = "#00A4D2";
  ctx.font = "600 34px Oswald, sans-serif";
  ctx.fillText("ANADOLU EFES · ROAD TO GLORY", W / 2, 110);

  ctx.fillStyle = "#EDEAE2";
  ctx.font = "700 210px Oswald, sans-serif";
  ctx.fillText(`${wins}–${losses}`, W / 2, 320);

  ctx.font = "600 44px Oswald, sans-serif";
  ctx.fillStyle = champion ? "#E2C15B" : "#8B9CB5";
  ctx.fillText(champion ? "🏆 EUROLEAGUE CHAMPIONS" : `GRADE ${letterGrade(wins)}`, W / 2, 390);

  // roster
  ctx.textAlign = "left";
  let y = 480;
  const starters = state.roster.filter((p) => p.tier === "starter");
  const bench = state.roster.filter((p) => p.tier !== "starter");

  ctx.fillStyle = "#00A4D2";
  ctx.font = "600 32px Oswald, sans-serif";
  ctx.fillText("STARTING FIVE", 90, y);
  y += 20;

  starters.forEach((p) => {
    y += 58;
    ctx.fillStyle = "#00A4D2";
    ctx.font = "600 30px Oswald, sans-serif";
    ctx.fillText(p.filledPosition || "", 90, y);
    ctx.fillStyle = "#EDEAE2";
    ctx.font = "700 36px 'Work Sans', sans-serif";
    ctx.fillText(p.name, 180, y);
    ctx.fillStyle = "#8B9CB5";
    ctx.font = "400 28px 'Work Sans', sans-serif";
    ctx.fillText(p.season, 700, y);
  });

  if (bench.length) {
    y += 70;
    ctx.fillStyle = "#00A4D2";
    ctx.font = "600 32px Oswald, sans-serif";
    ctx.fillText("BENCH", 90, y);
    ctx.fillStyle = "#8B9CB5";
    ctx.font = "400 26px 'Work Sans', sans-serif";
    const names = bench.map((p) => p.name).join(" · ");
    wrapText(ctx, names, 90, y + 42, W - 180, 34);
    y += 42 + 34 * Math.ceil(names.length / 58);
  }

  if (state.coach) {
    y += 60;
    ctx.fillStyle = "#00A4D2";
    ctx.font = "600 32px Oswald, sans-serif";
    ctx.fillText("HEAD COACH", 90, y);
    ctx.fillStyle = "#EDEAE2";
    ctx.font = "700 36px 'Work Sans', sans-serif";
    ctx.fillText(state.coach.name, 330, y);
  }

  ctx.textAlign = "center";
  ctx.fillStyle = "#8B9CB5";
  ctx.font = "400 26px 'Work Sans', sans-serif";
  ctx.fillText("Can your all-time Efes roster lift the trophy?", W / 2, H - 60);

  const link = document.getElementById("share-download");
  if (link) link.href = canvas.toDataURL("image/png");
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(" ");
  let line = "";
  for (const word of words) {
    const test = line + word + " ";
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line.trim(), x, y);
      line = word + " ";
      y += lineHeight;
    } else {
      line = test;
    }
  }
  ctx.fillText(line.trim(), x, y);
}

function honorsHtml(honors) {
  if (!honors.length) return "";
  return `<div class="honor-row">${honors.map((h) => `<span class="honor-badge">${h}</span>`).join("")}</div>`;
}

// Era styling: older seasons get a warmer, more retro card treatment.
function eraClassOf(season) {
  const y = parseInt(season.split("-")[0], 10);
  if (y < 2003) return "retro";
  if (y < 2013) return "classic";
  return "modern";
}

let lastResult = null;

function showAchievementToasts(list) {
  list.forEach((a, i) => {
    setTimeout(() => {
      const toast = document.createElement("div");
      toast.className = "achv-toast";
      toast.innerHTML = `<span class="achv-toast-icon">★</span><div><div class="achv-toast-name">${a.name}</div><div class="achv-toast-desc">${a.desc}</div></div>`;
      document.body.appendChild(toast);
      setTimeout(() => toast.classList.add("show"), 30);
      setTimeout(() => { toast.classList.remove("show"); setTimeout(() => toast.remove(), 400); }, 3600);
    }, i * 500);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const vb = document.getElementById("version-badge");
  if (vb) vb.textContent = APP_VERSION;
  renderChallenges();
  renderAchievements();

  const shareBtn = document.getElementById("share-btn");
  if (shareBtn) {
    shareBtn.addEventListener("click", () => {
      if (!lastResult) return;
      drawShareCard(lastResult.wins, lastResult.losses, lastResult.champion);
      document.getElementById("share-modal").hidden = false;
    });
  }
  const shareClose = document.getElementById("share-close");
  if (shareClose) shareClose.addEventListener("click", () => {
    document.getElementById("share-modal").hidden = true;
  });
});

// ============================================================
// v12 additions: sounds, theme, loading, history, re-sim,
// player detail, season context, lineup intro, game scores
// ============================================================

// ---------- Sound (synthesized with WebAudio — no audio files needed) ----------
let audioCtx = null;
let soundOn = localStorage.getItem("efes380_sound") !== "off";

function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  return audioCtx;
}

function tone(freq, durationMs, type = "sine", gainVal = 0.06) {
  if (!soundOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(gainVal, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationMs / 1000);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + durationMs / 1000);
}

function noiseBurst(durationMs, gainVal = 0.05) {
  if (!soundOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const frames = Math.floor((ctx.sampleRate * durationMs) / 1000);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.value = gainVal;
  src.buffer = buffer;
  src.connect(gain).connect(ctx.destination);
  src.start();
}

const SFX = {
  bounce: () => tone(180, 120, "sine", 0.07),
  place: () => { tone(440, 90, "triangle", 0.05); setTimeout(() => tone(660, 110, "triangle", 0.04), 70); },
  spin: () => tone(320, 70, "square", 0.025),
  win: () => tone(720, 90, "sine", 0.04),
  loss: () => tone(200, 110, "sawtooth", 0.035),
  whistle: () => { tone(1800, 180, "square", 0.03); setTimeout(() => tone(2100, 160, "square", 0.025), 120); },
  crowd: () => { noiseBurst(1400, 0.05); setTimeout(() => noiseBurst(1000, 0.035), 500); },
};

// ---------- Theme ----------
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("efes380_theme", theme);
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.textContent = theme === "light" ? "☀️" : "🌙";
}

// ---------- Roster history ----------
const HISTORY_KEY = "efes380_history_v1";

function saveHistoryEntry(entry) {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
    list.unshift(entry);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 5)));
  } catch { /* storage unavailable */ }
}

function renderHistory() {
  const block = document.getElementById("history-block");
  const list = document.getElementById("history-list");
  if (!block || !list) return;
  let entries = [];
  try { entries = JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { entries = []; }
  if (!entries.length) { block.hidden = true; return; }
  block.hidden = false;
  list.innerHTML = "";
  entries.forEach((e) => {
    const el = document.createElement("div");
    el.className = "history-card";
    el.innerHTML = `
      <div class="history-rec">${e.wins}–${e.losses}</div>
      <div class="history-meta">
        <div class="history-names">${e.starters.join(" · ")}</div>
        <div class="history-sub">${e.mode} · ${e.budget}${e.champion ? " · 🏆 Champions" : ""}</div>
      </div>`;
    list.appendChild(el);
  });
}

// ---------- Season context (only verifiable club history) ----------
const SEASON_NOTES = {
  "1995-96": "Korać Cup winners",
  "1999-00": "First Turkish team in a EuroLeague Final Four",
  "2000-01": "SuproLeague Final Four",
  "2018-19": "EuroLeague runners-up",
  "2019-20": "Season cancelled (COVID-19) while leading",
  "2020-21": "EuroLeague Champions",
  "2021-22": "EuroLeague Champions",
};

function seasonNoteHtml(season) {
  const note = SEASON_NOTES[season];
  return note ? `<span class="season-note">${note}</span>` : "";
}

// ---------- Player detail modal ----------
function openPlayerModal(name) {
  const body = document.getElementById("player-modal-body");
  const modal = document.getElementById("player-modal");
  if (!body || !modal) return;

  const rows = [];
  for (const [season, list] of Object.entries(state.playersBySeason)) {
    const p = list.find((x) => x.name === name);
    if (p) rows.push({ season, p });
  }
  rows.sort((a, b) => a.season.localeCompare(b.season));

  const positions = rows.length ? rows[rows.length - 1].p.positions.join(" / ") : "";
  const tableRows = rows
    .map(({ season, p }) => {
      const e = p.euroleague, b = p.bsl;
      return `<tr>
        <td>${season}</td>
        <td>${e ? e.pts.toFixed(1) : "–"}</td>
        <td>${e ? e.reb.toFixed(1) : "–"}</td>
        <td>${e ? e.ast.toFixed(1) : "–"}</td>
        <td>${b ? b.pts.toFixed(1) : "–"}</td>
        <td>${b ? b.reb.toFixed(1) : "–"}</td>
        <td>${b ? b.ast.toFixed(1) : "–"}</td>
      </tr>`;
    })
    .join("");

  body.innerHTML = `
    <div class="pm-head">
      <div class="pm-name">${name}</div>
      <div class="pm-pos">${positions} · ${rows.length} season${rows.length === 1 ? "" : "s"} with Efes</div>
    </div>
    <table class="pm-table">
      <thead>
        <tr><th rowspan="2">Season</th><th colspan="3">EuroLeague</th><th colspan="3">BSL</th></tr>
        <tr><th>PTS</th><th>REB</th><th>AST</th><th>PTS</th><th>REB</th><th>AST</th></tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>`;
  modal.hidden = false;
}

// ---------- Lineup intro ----------
function renderLineupIntro(onDone) {
  const stage = document.getElementById("lineup-stage");
  const banner = document.getElementById("lineup-coach-banner");
  if (!stage) { onDone(); return; }
  stage.innerHTML = "";

  const starters = POSITION_ORDER.map((pos) =>
    state.roster.find((p) => p.tier === "starter" && p.filledPosition === pos)
  ).filter(Boolean);

  starters.forEach((p, i) => {
    const el = document.createElement("div");
    el.className = "lineup-player";
    el.style.animationDelay = i * 0.55 + "s";
    el.innerHTML = `
      <div class="lineup-pos">${p.filledPosition}</div>
      ${avatarHtml(p.name)}
      <div class="lineup-name">${p.name}</div>
      <div class="lineup-season">${p.season}</div>`;
    stage.appendChild(el);
    setTimeout(() => SFX.bounce(), i * 550 + 100);
  });

  if (banner) {
    banner.textContent = state.coach ? `Head Coach: ${state.coach.name}` : "";
    banner.hidden = !state.coach;
  }
}

// ---------- v12 event wiring ----------
document.addEventListener("DOMContentLoaded", () => {
  applyTheme(localStorage.getItem("efes380_theme") || "dark");
  const themeBtn = document.getElementById("theme-toggle");
  if (themeBtn) themeBtn.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    applyTheme(next);
  });

  const soundBtn = document.getElementById("sound-toggle");
  if (soundBtn) {
    soundBtn.textContent = soundOn ? "🔊" : "🔇";
    soundBtn.addEventListener("click", () => {
      soundOn = !soundOn;
      localStorage.setItem("efes380_sound", soundOn ? "on" : "off");
      soundBtn.textContent = soundOn ? "🔊" : "🔇";
      if (soundOn) SFX.bounce();
    });
  }

  renderHistory();

  // Player detail: the info button opens the modal without selecting the player.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".info-btn");
    if (btn) {
      e.stopPropagation();
      openPlayerModal(btn.dataset.player);
    }
  }, true);

  const pmClose = document.getElementById("player-modal-close");
  if (pmClose) pmClose.addEventListener("click", () => {
    document.getElementById("player-modal").hidden = true;
  });

  // Re-simulate the same roster
  const resimBtn = document.getElementById("resim-btn");
  if (resimBtn) resimBtn.addEventListener("click", () => {
    document.getElementById("final-record").hidden = true;
    document.getElementById("season-narrative").hidden = true;
    document.getElementById("result-actions").hidden = true;
    document.getElementById("scoreboard-track").innerHTML = "";
    document.getElementById("sim-btn").hidden = false;
    document.getElementById("sim-btn").click();
  });

  // Spin sound
  ["spin-btn", "respin-btn", "coach-spin-btn", "coach-respin-btn"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", () => SFX.spin());
  });

  // Hide the loading overlay once data is ready (or on failure, so it never sticks).
  const overlay = document.getElementById("loading-overlay");
  const hideOverlay = () => { if (overlay) overlay.classList.add("done"); };
  const check = setInterval(() => {
    if (state.dataReady) { clearInterval(check); hideOverlay(); }
  }, 100);
  setTimeout(() => { clearInterval(check); hideOverlay(); }, 8000);
});

// ============================================================
// v13 additions: captain, trade, halftime, chart, leaders, MVP,
// legends, timeline, flags, height, tutorial, tips, error guard
// ============================================================

let lastMargin = 0;

// ---------- Captain ----------
function setCaptain(name) {
  state.captainName = name;
  renderRosterCards("roster-grid", null);
  const hint = document.getElementById("captain-hint");
  if (hint) hint.textContent = `Captain: ${name} — their contribution counts for more.`;
  SFX.place();
}

// ---------- Trade one player ----------
function startTrade() {
  state.tradeMode = true;
  const hint = document.getElementById("captain-hint");
  if (hint) hint.textContent = "Trade mode: tap a player to send them back and re-spin for a replacement.";
  renderRosterCards("roster-grid", null);
}

function executeTrade(player) {
  const idx = state.roster.findIndex((p) => p.name === player.name);
  if (idx === -1) return;
  const removed = state.roster.splice(idx, 1)[0];
  state.usedPlayerNames.delete(removed.name);
  if (removed.tier !== "free" && removed.filledPosition) {
    openSetForTier(removed.tier).add(removed.filledPosition);
  }
  if (state.budgetType === "cap") {
    state.budgetSpent -= getPlayerPrice(removed);
    updateBudgetGauge();
  }
  if (state.captainName === removed.name) state.captainName = null;
  state.tradeUsed = true;
  state.tradeMode = false;
  state.currentSlot = state.roster.length;
  showScreen("screen-draft");
  renderDraftStep();
}

// ---------- Nationality flag + height on cards ----------
function flagEmoji(code) {
  if (!code || code.length !== 2) return "";
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 127397 + c.charCodeAt(0)));
}

function bioLineHtml(p) {
  const bits = [];
  if (p.countryCode) bits.push(`<span class="bio-flag" title="${p.country || ""}">${flagEmoji(p.countryCode)}</span>`);
  if (p.height) bits.push(`<span class="bio-height">${p.height} m</span>`);
  return bits.length ? `<div class="bio-line">${bits.join("")}</div>` : "";
}

// ---------- Season MVP + stat leaders ----------
function renderMvpAndLeaders() {
  const mvpEl = document.getElementById("mvp-card");
  const leadersEl = document.getElementById("stat-leaders");
  if (!mvpEl || !leadersEl) return;

  const roster = state.roster;
  if (!roster.length) return;

  const mvp = roster.reduce((best, p) => (p.rating > best.rating ? p : best));
  mvpEl.hidden = false;
  mvpEl.innerHTML = `
    <div class="mvp-label">Team MVP</div>
    <div class="mvp-body">
      ${avatarHtml(mvp.name)}
      <div>
        <div class="mvp-name">${mvp.name}</div>
        <div class="mvp-season">${mvp.season}${state.captainName === mvp.name ? " · Captain" : ""}</div>
      </div>
    </div>`;

  function leaderIn(stat) {
    let best = null, bestVal = -1;
    roster.forEach((p) => {
      const v = statValue(p, stat);
      if (v > bestVal) { bestVal = v; best = p; }
    });
    return best ? `<div class="leader"><span class="leader-stat">${stat.toUpperCase()}</span><span class="leader-name">${best.name}</span><span class="leader-val">${bestVal.toFixed(1)}</span></div>` : "";
  }
  leadersEl.hidden = false;
  leadersEl.innerHTML = `<div class="leaders-title">Squad Leaders</div><div class="leaders-row">${["pts","reb","ast","blk","stl"].map(leaderIn).join("")}</div>`;
}

// ---------- Season chart ----------
function drawSeasonChart(results) {
  const canvas = document.getElementById("season-chart");
  if (!canvas) return;
  canvas.hidden = false;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue("--accent").trim() || "#00A4D2";
  const muted = style.getPropertyValue("--muted").trim() || "#8B9CB5";

  // running win differential
  let diff = 0;
  const pts = results.map((r) => (diff += r === "W" ? 1 : -1));
  const maxAbs = Math.max(4, ...pts.map(Math.abs));
  const pad = 24;
  const stepX = (W - pad * 2) / (pts.length - 1);
  const midY = H / 2;
  const scaleY = (H / 2 - pad) / maxAbs;

  ctx.strokeStyle = muted;
  ctx.globalAlpha = 0.35;
  ctx.beginPath(); ctx.moveTo(pad, midY); ctx.lineTo(W - pad, midY); ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  ctx.beginPath();
  pts.forEach((v, i) => {
    const x = pad + i * stepX, y = midY - v * scaleY;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = muted;
  ctx.font = "11px 'Work Sans', sans-serif";
  ctx.fillText("Game 1", pad, H - 6);
  ctx.fillText("Game 38", W - pad - 48, H - 6);
  ctx.fillText("Win differential", pad, 14);
}

// ---------- Month labels on the scoreboard ----------
const SEASON_MONTHS = ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr"];
function renderMonthLabels() {
  const el = document.getElementById("scoreboard-months");
  if (!el) return;
  el.innerHTML = SEASON_MONTHS.map((m) => `<span>${m}</span>`).join("");
}

// ---------- Legends showcase ----------
// Career legend index. Ranking by a single best season let small-sample
// outliers (a 6-game cameo) top the list, so this uses a games-weighted career
// average, multiplied by a longevity factor and a small EuroLeague-tenure
// bonus, with a minimum career-games threshold to keep cameos out entirely.
const LEGEND_MIN_GAMES = 40;
const PRODUCTION_WEIGHT = 0.6;
const TROPHY_MULTIPLIER = 2.0;
const INDIVIDUAL_WEIGHT = 7;

// Silverware the club actually won, and what a season was worth.
const TROPHY_WEIGHT = { "2020-21": 7, "2021-22": 7 };   // EuroLeague titles
const FINAL_WEIGHT  = { "2018-19": 3 };                  // EuroLeague final
const F4_WEIGHT     = { "1999-00": 2, "2000-01": 2 };    // Final Four runs

// Individual distinction earned in an Efes shirt. Kept short and deliberate —
// only players whose personal honours or era-defining role are well documented.
const INDIVIDUAL_HONOURS = {
  "Vasilije Micic": 3.0,
  "Shane Larkin": 2.2,
  "Petar Naumoski": 2.0,
  "Bryant Dunston": 1.4,
  "Mirsad Türkcan": 1.2,
  "Hidayet Türkoğlu": 1.2,
  "Mehmet Okur": 1.2,
  "Predrag Drobnjak": 1.0,
  "Hüseyin Beşok": 0.8,
  "Kerem Gonlum": 1.0,   // long-serving club figure and captain
  "Kerem Tunceri": 0.8,
  "Damir Mulaomerović": 0.8,
  "Charles Smith": 0.8,
};

function computeLegendIndex() {
  const byName = new Map();
  for (const [season, list] of Object.entries(state.playersBySeason)) {
    list.forEach((p) => {
      const gp =
        (p.euroleague ? parseInt(p.euroleague.gp) || 0 : 0) +
        (p.bsl ? parseInt(p.bsl.gp) || 0 : 0);
      if (!byName.has(p.name)) {
        byName.set(p.name, { name: p.name, seasons: [], totalGp: 0, weighted: 0, elSeasons: 0, trophy: 0, titles: 0, sample: p, peak: null });
      }
      const e = byName.get(p.name);
      e.seasons.push(season);
      e.totalGp += gp;
      e.weighted += p.rating * gp;
      if (p.euroleague) e.elSeasons++;
      if (!e.peak || e.peak.rating < p.rating) e.peak = { rating: p.rating, season };
      if (p.countryCode) e.sample = p;

      // Trophy credit is scaled by how much the player actually contributed that
      // season, so a squad member who barely played doesn't rank alongside the
      // people who won it.
      const w = TROPHY_WEIGHT[season] || FINAL_WEIGHT[season] || F4_WEIGHT[season] || 0;
      if (w) {
        // Squared so a fringe squad member on a title team earns only a
        // fraction of the credit an actual contributor does.
        const share = Math.pow(Math.min(1, gp / 34) * Math.min(1, Math.max(p.rating, 0) / 13), 2);
        e.trophy += w * share;
        if (TROPHY_WEIGHT[season]) e.titles++;
      }
    });
  }
  return [...byName.values()]
    // A legend is defined by what the club won with them, not by averages
    // alone. A player needs either a real contribution to silverware or a
    // documented individual distinction to appear here at all — otherwise a
    // productive spell with nothing to show for it would rank as highly as a
    // title-winning one.
    .filter((e) => e.totalGp >= LEGEND_MIN_GAMES && (e.trophy > 0.35 || INDIVIDUAL_HONOURS[e.name]))
    .map((e) => {
      const avg = e.totalGp > 0 ? e.weighted / e.totalGp : 0;
      // Being a legend is about what you won, not only what you averaged. Raw
      // production is deliberately damped so a productive player with no
      // silverware can't outrank the people who actually lifted trophies.
      const production = avg * Math.sqrt(e.seasons.length) * (1 + Math.min(e.elSeasons, 6) * 0.04) * PRODUCTION_WEIGHT;
      const individual = (INDIVIDUAL_HONOURS[e.name] || 0) * INDIVIDUAL_WEIGHT;
      return { ...e, avg, production, individual, score: production + e.trophy * TROPHY_MULTIPLIER + individual };
    })
    .sort((a, b) => b.score - a.score);
}

function renderLegends() {
  const grid = document.getElementById("legends-grid");
  if (!grid) return;
  const top = computeLegendIndex().slice(0, 20);

  grid.innerHTML = "";
  top.forEach((e, i) => {
    const p = e.sample;
    const first = e.seasons[0];
    const last = e.seasons[e.seasons.length - 1];
    const span = first === last ? first : `${first.split("-")[0]}–${last.split("-")[1]}`;
    const el = document.createElement("div");
    el.className = "legend-card" + (i < 3 ? " legend-top" : "");
    el.innerHTML = `
      <div class="legend-rank">${i + 1}</div>
      ${avatarHtml(e.name)}
      <div class="legend-info">
        <div class="legend-name">${e.name}</div>
        <div class="legend-sub">${span} · ${e.seasons.length} recorded season${e.seasons.length === 1 ? "" : "s"} · ${e.totalGp} games ${p.countryCode ? flagEmoji(p.countryCode) : ""}</div>
        <div class="legend-bar"><span style="width:${Math.min(100, (e.score / top[0].score) * 100)}%"></span></div>
        ${e.titles ? `<div class="legend-trophies">${"🏆".repeat(e.titles)} ${e.titles} EuroLeague title${e.titles > 1 ? "s" : ""}</div>` : ""}
      </div>
      <div class="legend-peak" title="Best season">${e.peak.season}</div>`;
    el.addEventListener("click", () => openPlayerModal(e.name));
    grid.appendChild(el);
  });
}

// ---------- Club timeline (verified club milestones) ----------
const TIMELINE = [
  { year: "1996", text: "First Turkish club to win a European trophy — the Korać Cup." },
  { year: "2000", text: "First Turkish team to reach a EuroLeague Final Four." },
  { year: "2001", text: "Reached the SuproLeague Final Four." },
  { year: "2019", text: "EuroLeague runners-up." },
  { year: "2020", text: "Leading the EuroLeague when the season was cancelled." },
  { year: "2021", text: "EuroLeague Champions — the club's first continental title." },
  { year: "2022", text: "EuroLeague Champions again — back-to-back." },
];

function renderTimeline() {
  const el = document.getElementById("timeline");
  if (!el) return;
  el.innerHTML = TIMELINE.map(
    (t) => `<div class="tl-item"><div class="tl-year">${t.year}</div><div class="tl-text">${t.text}</div></div>`
  ).join("");
}

// ---------- Loading tips ----------
const LOADING_TIPS = [
  "Tip: Build your starting five from a single season to unlock Time Capsule.",
  "Tip: A best-of-five quarterfinal awaits — depth matters.",
  "Tip: Your captain's contribution counts for more.",
  "Tip: You get one trade after the roster is complete.",
  "Tip: Winning the trophy matters more than a perfect record.",
];

// ---------- First-time tutorial ----------
function maybeShowTutorial() {
  if (localStorage.getItem("efes380_tutorial_seen")) return;
  const steps = [
    "1 — Spin to reveal a season from Efes history.",
    "2 — Pick any player from that season's squad.",
    "3 — Place them on the court, then chase the trophy.",
  ];
  const el = document.createElement("div");
  el.className = "tutorial-overlay";
  el.innerHTML = `
    <div class="tutorial-box">
      <div class="tutorial-title">How it works</div>
      ${steps.map((s) => `<div class="tutorial-step">${s}</div>`).join("")}
      <button class="btn-primary" id="tutorial-close">Got it</button>
    </div>`;
  document.body.appendChild(el);
  el.querySelector("#tutorial-close").addEventListener("click", () => {
    localStorage.setItem("efes380_tutorial_seen", "1");
    el.remove();
  });
}

// ---------- Error guard ----------
window.addEventListener("error", (e) => {
  if (document.querySelector(".fatal-error")) return;
  const box = document.createElement("div");
  box.className = "fatal-error";
  box.innerHTML = `
    <div class="fatal-box">
      <div class="fatal-title">Something went wrong</div>
      <div class="fatal-desc">The game hit an unexpected error. Restarting usually fixes it.</div>
      <button class="btn-primary" onclick="location.reload()">Restart</button>
    </div>`;
  document.body.appendChild(box);
});

// ---------- v13 event wiring ----------
document.addEventListener("DOMContentLoaded", () => {
  renderLegends_whenReady();
  renderTimeline();
  renderMonthLabels();
  maybeShowTutorial();

  // Loading tips cycle
  const tipEl = document.getElementById("loading-text");
  if (tipEl) {
    let ti = 0;
    tipEl.textContent = LOADING_TIPS[0];
    setInterval(() => {
      ti = (ti + 1) % LOADING_TIPS.length;
      tipEl.textContent = LOADING_TIPS[ti];
    }, 1800);
  }

  // Home tabs
  document.querySelectorAll(".home-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".home-tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".home-panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(tab.dataset.panel).classList.add("active");
    });
  });

  // Trade
  const tradeBtn = document.getElementById("trade-btn");
  if (tradeBtn) tradeBtn.addEventListener("click", () => {
    if (state.tradeUsed) return;
    startTrade();
    tradeBtn.disabled = true;
    tradeBtn.textContent = "Tap a player to trade";
  });

  // Playoffs entry
  const toPo = document.getElementById("to-playoffs-btn");
  if (toPo) toPo.addEventListener("click", () => {
    showScreen("screen-standings");
    SFX.whistle();
    lastUserRank = renderStandings(lastResult ? lastResult.wins : 0);
  });

  const toBracket = document.getElementById("to-bracket-btn");
  if (toBracket) toBracket.addEventListener("click", () => {
    showScreen("screen-playoffs");
    SFX.whistle();
    playPlayoffs(lastMargin, lastUserRank);
  });

  const poShare = document.getElementById("playoff-share-btn");
  if (poShare) poShare.addEventListener("click", () => {
    if (!lastResult) return;
    drawShareCard(lastResult.wins, lastResult.losses, lastPlayoffChampion);
    document.getElementById("share-modal").hidden = false;
  });

  const poRestart = document.getElementById("playoff-restart-btn");
  if (poRestart) poRestart.addEventListener("click", resetToCategory);
});

function renderLegends_whenReady() {
  const t = setInterval(() => {
    if (state.dataReady) { clearInterval(t); renderLegends(); }
  }, 150);
  setTimeout(() => clearInterval(t), 10000);
}

// Confetti in the club's kit colours.
const KIT_CONFETTI = ["#213557", "#F4EFE3", "#00A4D2"];

function countUpRecord(wins, losses) {
  const el = document.getElementById("big-record");
  if (!el) return;
  const steps = 26;
  let i = 0;
  const t = setInterval(() => {
    i++;
    const w = Math.round((wins * i) / steps);
    const l = Math.round((losses * i) / steps);
    el.textContent = `${w}–${l}`;
    if (i >= steps) { clearInterval(t); el.textContent = `${wins}–${losses}`; }
  }, 45);
}

// ============================================================
// v14 — mobile experience
//
// The core mobile problem: HTML5 drag-and-drop doesn't fire on touch devices,
// and stacking the pool under the court meant a user had to scroll up and down
// for every single pick. Both are solved by a fixed bottom placement bar: tap a
// player, the bar rises with one button per open slot, tap to place. No
// scrolling, no dragging. The desktop layout is untouched.
// ============================================================

function isMobileViewport() {
  return window.matchMedia("(max-width: 860px)").matches;
}

function openSlotsForCurrentTier() {
  const tier = getCurrentTier();
  if (tier === "free") return ["BENCH"];
  return POSITION_ORDER.filter((pos) => openSetForTier(tier).has(pos));
}

function slotsPlayerCanFill(player) {
  const tier = getCurrentTier();
  if (tier === "free") return ["BENCH"];
  if (tier === "backup") return POSITION_ORDER.filter((pos) => openSetForTier(tier).has(pos));
  return player.positions.filter((pos) => openSetForTier(tier).has(pos));
}

function updatePlaceBar() {
  const bar = document.getElementById("place-bar");
  if (!bar) return;
  const p = state.armedPlayer;
  if (!p) { bar.hidden = true; return; }

  const slots = slotsPlayerCanFill(p);
  if (!slots.length) { bar.hidden = true; return; }

  document.getElementById("place-bar-player").innerHTML =
    `${avatarHtml(p.name)}<div class="pb-info"><div class="pb-name">${p.name}</div><div class="pb-sub">${state.currentSpinSeason} · ${p.positions.join("/")}</div></div>`;

  const actions = document.getElementById("place-bar-actions");
  actions.innerHTML = "";
  slots.forEach((slot) => {
    const btn = document.createElement("button");
    btn.className = "pb-slot-btn";
    btn.textContent = slot === "BENCH" ? "Add to bench" : slot;
    btn.addEventListener("click", () => {
      const player = state.armedPlayer;
      state.armedPlayer = null;
      bar.hidden = true;
      placePlayer(player, slot === "BENCH" ? null : slot);
    });
    actions.appendChild(btn);
  });
  bar.hidden = false;
}

// Compact lineup strip so a mobile user always sees what's filled without
// scrolling back to the court.
function renderMobileLineupStrip() {
  const strip = document.getElementById("mobile-lineup-strip");
  if (!strip) return;
  const tier = getCurrentTier();
  if (!isMobileViewport() || tier === "free") { strip.hidden = true; return; }

  const set = tier === "starter" ? "starter" : "backup";
  strip.hidden = false;
  strip.innerHTML = POSITION_ORDER.map((pos) => {
    const occupant = state.roster.find((p) => p.tier === set && p.filledPosition === pos);
    const short = occupant ? occupant.name.split(" ").slice(-1)[0] : "";
    return `<div class="mls-slot ${occupant ? "filled" : ""}">
      <span class="mls-pos">${pos}</span>
      <span class="mls-name">${short || "—"}</span>
    </div>`;
  }).join("");
}

document.addEventListener("DOMContentLoaded", () => {
  const cancel = document.getElementById("place-bar-cancel");
  if (cancel) cancel.addEventListener("click", () => {
    state.armedPlayer = null;
    document.getElementById("place-bar").hidden = true;
    renderPlayerPool(state.currentSpinPool);
    renderCourt();
    renderBench();
    updateCourtHint();
  });

  window.addEventListener("resize", () => {
    renderMobileLineupStrip();
  });
});

// ---------- Decade wheel (One Decade challenge) ----------
function availableDecades() {
  const set = new Set();
  Object.keys(state.playersBySeason).forEach((s) => set.add(decadeOf(s)));
  return [...set].sort((a, b) => a - b);
}

function spinDecadeThenSeason() {
  const decades = availableDecades().filter((d) => {
    // only decades that can actually supply a full roster's worth of seasons
    return Object.keys(state.playersBySeason).filter((s) => decadeOf(s) === d).length > 0;
  });
  const chosen = pickRandom(decades);

  document.getElementById("spin-panel").style.display = "none";
  document.getElementById("spin-result").hidden = true;
  document.getElementById("pool-controls").hidden = true;
  document.getElementById("player-pool").innerHTML = "";

  const animEl = document.getElementById("spin-anim");
  const labelEl = document.getElementById("spin-anim-label");
  animEl.hidden = false;
  const shuffle = setInterval(() => {
    labelEl.textContent = pickRandom(decades) + "s";
  }, 80);

  setTimeout(() => {
    clearInterval(shuffle);
    labelEl.textContent = chosen + "s";
    state.lockedDecade = chosen;
    const banner = document.getElementById("decade-banner");
    if (banner) {
      banner.hidden = false;
      banner.textContent = `Locked to the ${chosen}s`;
    }
    setTimeout(() => {
      animEl.hidden = true;
      doSpin();
    }, 700);
  }, 700);
}

// ============================================================
// League standings + playoff bracket with real EuroLeague teams
// ============================================================
async function loadTeams() {
  const res = await fetch("data/teams.json");
  const data = await res.json();
  state.teams = data.teams;
}

// Convert a team's 0-10 strength index into an expected win total over 38 games.
// Anchored so the strongest sides land in the mid-20s and the weakest around 10,
// which is what the real EuroLeague table looks like.
function expectedWinsFor(strength) {
  return 6 + strength * 2.0;
}

function buildStandings(userWins) {
  const rows = state.teams.map((t) => {
    const expected = expectedWinsFor(t.strength);
    // Season-to-season noise, but small enough that a weak side can't leap to
    // the top: a 17th-placed team stays in that neighbourhood.
    const wins = Math.max(2, Math.min(36, Math.round(expected + gaussian() * 1.7)));
    // Points differential correlates with record but carries its own noise, so
    // it can genuinely separate two teams level on wins.
    const diff = Math.round((wins - 19) * 5.2 + gaussian() * 18);
    return { ...t, wins, losses: 38 - wins, diff, isUser: false };
  });
  rows.push({
    name: "Anadolu Efes",
    short: "EFS",
    colors: ["#0D2C6B", "#FFFFFF"],
    wins: userWins,
    losses: 38 - userWins,
    diff: Math.round((userWins - 19) * 5.2 + gaussian() * 12),
    isUser: true,
  });
  // Wins first, then points differential — the league's own tiebreaker order
  // once head-to-head results are level.
  rows.sort((a, b) => b.wins - a.wins || b.diff - a.diff);
  state.standings = rows;
  return rows;
}

function renderStandings(userWins) {
  const el = document.getElementById("standings-table");
  if (!el) return;
  const rows = buildStandings(userWins);
  const userRank = rows.findIndex((r) => r.isUser) + 1;

  el.innerHTML = rows
    .map((r, i) => {
      const rank = i + 1;
      const zone = rank <= 6 ? "zone-playoff" : rank <= 10 ? "zone-playin" : "";
      return `<div class="standing-row ${r.isUser ? "is-user" : ""} ${zone}">
        <span class="st-rank">${rank}</span>
        <span class="st-badge" style="background:${r.colors[0]};color:${r.colors[1]}">${r.short}</span>
        <span class="st-name">${r.name}</span>
        <span class="st-rec">${r.wins}–${r.losses}</span>
        <span class="st-diff ${r.diff >= 0 ? "pos" : "neg"}">${r.diff >= 0 ? "+" : ""}${r.diff}</span>
      </div>`;
    })
    .join("");

  const note = document.getElementById("standings-note");
  if (note) {
    note.textContent =
      userRank <= 6
        ? `You finished ${userRank}${ordinal(userRank)} — a bye straight into the quarterfinals.`
        : userRank <= 10
        ? `You finished ${userRank}${ordinal(userRank)} — into the Play-In Showdown for one of the last two playoff spots.`
        : `You finished ${userRank}${ordinal(userRank)} — outside the top ten. The road ends here.`;
  }
  return userRank;
}

function ordinal(n) {
  if (n % 10 === 1 && n % 100 !== 11) return "st";
  if (n % 10 === 2 && n % 100 !== 12) return "nd";
  if (n % 10 === 3 && n % 100 !== 13) return "rd";
  return "th";
}

let lastUserRank = 1;

// ---------- Play-In Showdown (real EuroLeague format) ----------
// Seeds 7-10 fight for the last two playoff berths:
//   7v8  → winner takes the 7th seed outright
//   9v10 → loser is eliminated
//   loser of 7/8 vs winner of 9/10 → winner takes the 8th seed
function buildPlayIn(margin, userRank) {
  const others = state.standings.filter((r) => !r.isUser);
  // Pick opponents whose record sits nearest the seed we need to face.
  const nearestTo = (targetRank) => {
    const sorted = [...state.standings].sort((a, b) => b.wins - a.wins);
    const cand = sorted[targetRank - 1];
    return cand && !cand.isUser ? cand : others[Math.min(targetRank, others.length - 1)];
  };

  const stages = [];
  let advanced = false;

  if (userRank === 7 || userRank === 8) {
    const rivalRank = userRank === 7 ? 8 : 7;
    const g1 = playSeries(margin, nearestTo(rivalRank), 1, userRank === 7);
    stages.push({
      title: "Play-In · 7 vs 8",
      subtitle: userRank === 7 ? "Win and you're in as the 7 seed" : "Win and you're in as the 7 seed",
      ...g1,
    });
    if (g1.won) {
      advanced = true;
    } else {
      // Second chance against the survivor of the 9/10 game.
      const g2 = playSeries(margin, nearestTo(9), 1, true);
      stages.push({ title: "Play-In · Last Chance", subtitle: "Winner takes the final playoff spot", ...g2 });
      advanced = g2.won;
    }
  } else {
    // Seeds 9 and 10 must win twice.
    const rivalRank = userRank === 9 ? 10 : 9;
    const g1 = playSeries(margin, nearestTo(rivalRank), 1, userRank === 9);
    stages.push({ title: "Play-In · 9 vs 10", subtitle: "Lose and your season is over", ...g1 });
    if (g1.won) {
      const g2 = playSeries(margin, nearestTo(8), 1, false);
      stages.push({ title: "Play-In · Last Chance", subtitle: "Winner takes the final playoff spot", ...g2 });
      advanced = g2.won;
    } else {
      advanced = false;
    }
  }

  return { stages, advanced };
}

// ============================================================
// v18: full bracket, awards ceremony, draft autosave, F4 gap
// ============================================================

// ---------- Full bracket: simulate the other seven QF matchups too ----------
function buildFullBracket(userRank, userQfWon) {
  const sorted = [...state.standings].sort((a, b) => b.wins - a.wins || b.diff - a.diff);
  const eight = sorted.slice(0, 8);
  const pairs = [[0, 7], [3, 4], [1, 6], [2, 5]];

  return pairs.map(([hi, lo]) => {
    const a = eight[hi], b = eight[lo];
    if (!a || !b) return null;
    const aIsUser = a.isUser, bIsUser = b.isUser;
    let winner;
    if (aIsUser || bIsUser) {
      const user = aIsUser ? a : b;
      const other = aIsUser ? b : a;
      winner = userQfWon ? user : other;
    } else {
      // Higher seed is favoured, scaled by the gap in their records.
      const edge = (a.wins - b.wins) * 0.06 + 0.55;
      winner = Math.random() < Math.min(0.9, Math.max(0.5, edge)) ? a : b;
    }
    return { a, b, winner };
  }).filter(Boolean);
}

function renderBracket(userRank, userQfWon) {
  const el = document.getElementById("bracket-grid");
  if (!el) return;
  const ties = buildFullBracket(userRank, userQfWon);
  el.innerHTML = ties
    .map((t) => {
      const side = (team) => `
        <div class="bk-team ${t.winner === team ? "bk-win" : "bk-out"} ${team.isUser ? "bk-user" : ""}">
          <span class="st-badge" style="background:${team.colors[0]};color:${team.colors[1]}">${team.short}</span>
          <span class="bk-name">${team.name}</span>
          <span class="bk-rec">${team.wins}</span>
        </div>`;
      return `<div class="bk-tie">${side(t.a)}${side(t.b)}</div>`;
    })
    .join("");
}

// ---------- Awards ceremony ----------
function renderAwards() {
  const el = document.getElementById("awards-block");
  if (!el || !state.roster.length) return;
  const roster = [...state.roster].sort((a, b) => b.rating - a.rating);
  const mvp = roster[0];

  const bestOf = (stat) => {
    let best = null, bv = -1;
    state.roster.forEach((p) => {
      const v = statValue(p, stat);
      if (v > bv) { bv = v; best = p; }
    });
    return best;
  };
  const defender = bestOf("blk") || bestOf("stl");
  const allFirst = POSITION_ORDER
    .map((pos) => state.roster.find((p) => p.tier === "starter" && p.filledPosition === pos))
    .filter(Boolean);

  el.hidden = false;
  el.innerHTML = `
    <h3 class="awards-title">End-of-Season Awards</h3>
    <div class="awards-row">
      <div class="award-card award-mvp">
        <div class="award-label">Season MVP</div>
        ${avatarHtml(mvp.name)}
        <div class="award-name">${mvp.name}</div>
        <div class="award-sub">${mvp.season}</div>
      </div>
      ${defender ? `<div class="award-card">
        <div class="award-label">Best Defender</div>
        ${avatarHtml(defender.name)}
        <div class="award-name">${defender.name}</div>
        <div class="award-sub">${defender.season}</div>
      </div>` : ""}
      ${state.captainName ? `<div class="award-card">
        <div class="award-label">Captain</div>
        ${avatarHtml(state.captainName)}
        <div class="award-name">${state.captainName}</div>
        <div class="award-sub">Team leader</div>
      </div>` : ""}
    </div>
    <div class="all-team">
      <div class="award-label">All-EuroLeague First Team</div>
      <div class="all-team-row">
        ${allFirst.map((p) => `<div class="all-team-slot"><span class="att-pos">${p.filledPosition}</span><span class="att-name">${p.name}</span></div>`).join("")}
      </div>
    </div>`;
}

// ---------- Draft autosave ----------
const DRAFT_KEY = "efes380_draft_v1";

function saveDraftState() {
  try {
    if (!state.mode || !state.roster) return;
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      mode: state.mode,
      budgetType: state.budgetType,
      budgetTotal: state.budgetTotal,
      budgetSpent: state.budgetSpent,
      challenge: state.challenge,
      lockedDecade: state.lockedDecade,
      lockedSeasons: state.lockedSeasons,
      roster: state.roster,
      currentSlot: state.currentSlot,
      respinsUsed: state.respinsUsed,
      captainName: state.captainName,
      tradeUsed: state.tradeUsed,
      savedAt: Date.now(),
    }));
  } catch { /* storage unavailable */ }
}

function clearDraftState() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

function loadDraftState() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    // Only offer to resume a draft that is genuinely mid-flight.
    if (!d.roster || d.currentSlot >= (d.mode === "12" ? 12 : 5)) return null;
    if (Date.now() - (d.savedAt || 0) > 1000 * 60 * 60 * 24 * 7) return null;
    return d;
  } catch {
    return null;
  }
}

function resumeDraft(d) {
  state.mode = d.mode;
  state.totalSlots = d.mode === "12" ? 12 : 5;
  state.budgetType = d.budgetType;
  state.budgetTotal = d.budgetTotal;
  state.budgetSpent = d.budgetSpent;
  state.challenge = d.challenge || "none";
  state.lockedDecade = d.lockedDecade ?? null;
  state.lockedSeasons = d.lockedSeasons || [];
  state.roster = d.roster || [];
  state.currentSlot = d.currentSlot || 0;
  state.respinsUsed = d.respinsUsed || 0;
  state.respinsAllowed = d.mode === "5" ? 1 : 3;
  state.captainName = d.captainName || null;
  state.tradeUsed = !!d.tradeUsed;
  state.usedPlayerNames = new Set(state.roster.map((p) => p.name));

  state.openPositions = new Set(POSITION_ORDER);
  state.openBackupPositions = new Set(POSITION_ORDER);
  state.roster.forEach((p) => {
    if (p.tier === "starter" && p.filledPosition) state.openPositions.delete(p.filledPosition);
    if (p.tier === "backup" && p.filledPosition) state.openBackupPositions.delete(p.filledPosition);
  });

  document.getElementById("budget-panel").hidden = state.budgetType !== "cap";
  const sub = document.getElementById("budget-panel-sub");
  if (sub) sub.textContent = `Credits remaining out of ${state.budgetTotal}`;
  updateBudgetGauge();
  showScreen("screen-draft");
  renderDraftStep();
}

function maybeOfferResume() {
  const d = loadDraftState();
  if (!d) return;
  const bar = document.createElement("div");
  bar.className = "resume-bar";
  const picked = (d.roster || []).length;
  bar.innerHTML = `
    <div class="resume-text">You have an unfinished roster — ${picked} pick${picked === 1 ? "" : "s"} in.</div>
    <div class="resume-actions">
      <button class="btn-primary btn-small" id="resume-yes">Continue</button>
      <button class="btn-secondary btn-small" id="resume-no">Discard</button>
    </div>`;
  document.body.appendChild(bar);
  bar.querySelector("#resume-yes").addEventListener("click", () => { bar.remove(); resumeDraft(d); });
  bar.querySelector("#resume-no").addEventListener("click", () => { bar.remove(); clearDraftState(); });
}

document.addEventListener("DOMContentLoaded", () => {
  maybeOfferResume();
});

// ============================================================
// v19 — Career Mode
//
// A run of seasons instead of a one-off. Winning silverware grows next
// season's budget; missing the postseason shrinks it. You keep a small core
// and rebuild the rest each summer, so a title team decays unless you manage
// the cap well.
// ============================================================
const CAREER_KEY = "efes380_career_v1";
const CAREER_START_BUDGET = { 5: 120, 12: 280 };
const RETAIN_LIMIT = 3;

const CAREER_REWARDS = {
  champion: { budget: 26, label: "EuroLeague title" },
  runnerUp: { budget: 14, label: "Runner-up" },
  finalFour: { budget: 10, label: "Final Four" },
  playoffs: { budget: 5, label: "Playoff berth" },
  playIn: { budget: 0, label: "Play-in exit" },
  missed: { budget: -16, label: "Missed the postseason" },
};

function loadCareer() {
  try { return JSON.parse(localStorage.getItem(CAREER_KEY)); } catch { return null; }
}
function saveCareer(c) {
  try { localStorage.setItem(CAREER_KEY, JSON.stringify(c)); } catch { /* ignore */ }
}
function clearCareer() {
  try { localStorage.removeItem(CAREER_KEY); } catch { /* ignore */ }
}

function startCareer(mode) {
  const career = {
    mode,
    season: 1,
    budget: CAREER_START_BUDGET[mode === "12" ? 12 : 5],
    titles: 0,
    trophies: [],
    retained: [],
    history: [],
  };
  saveCareer(career);
  state.career = career;
  beginCareerSeason();
}

function beginCareerSeason() {
  const c = state.career;
  if (!c) return;
  state.budgetType = "cap";
  state.challenge = "none";
  startDraft(c.mode);
  // Career overrides the standard budget with the running one.
  state.budgetTotal = Math.round(c.budget);
  document.getElementById("budget-panel").hidden = false;
  const sub = document.getElementById("budget-panel-sub");
  if (sub) sub.textContent = `Credits remaining out of ${state.budgetTotal}`;

  // Carry the retained core straight into the new roster.
  if (c.retained && c.retained.length) {
    c.retained.forEach((p) => {
      if (state.currentSlot >= state.totalSlots) return;
      const tier = getCurrentTier();
      let slot = null;
      if (tier !== "free") {
        const open = [...openSetForTier(tier)];
        slot = tier === "starter"
          ? (p.positions.find((pos) => openSetForTier(tier).has(pos)) || open[0])
          : open[0];
      }
      state.currentSpinSeason = p.season;
      placePlayer(p, slot);
    });
  }
  updateBudgetGauge();
  updateCareerBanner();
}

function careerOutcome(userRank, medal, champion) {
  if (champion) return "champion";
  if (medal === "silver") return "runnerUp";
  if (medal === "bronze") return "finalFour";
  if (userRank <= 6) return "playoffs";
  if (userRank <= 10) return "playIn";
  return "missed";
}

function finishCareerSeason(userRank) {
  const c = state.career;
  if (!c) return;
  const outcome = careerOutcome(userRank, lastPlayoffMedal, lastPlayoffChampion);
  const reward = CAREER_REWARDS[outcome];

  c.history.push({
    season: c.season,
    wins: lastResult ? lastResult.wins : 0,
    losses: lastResult ? 38 - lastResult.wins : 0,
    rank: userRank,
    outcome: reward.label,
    champion: lastPlayoffChampion,
  });
  if (lastPlayoffChampion) { c.titles++; c.trophies.push(c.season); }
  c.budget = Math.max(70, c.budget + reward.budget);
  c.season++;
  saveCareer(c);
  renderCareerSummary(reward);
}

function renderCareerSummary(reward) {
  const c = state.career;
  const panel = document.getElementById("career-summary");
  if (!panel || !c) return;
  panel.hidden = false;
  const last = c.history[c.history.length - 1];
  panel.innerHTML = `
    <div class="career-head">
      <div class="career-season-label">Season ${last.season} complete</div>
      <div class="career-outcome">${last.outcome}</div>
    </div>
    <div class="career-stats">
      <div><span class="cs-val">${last.wins}–${last.losses}</span><span class="cs-lbl">Record</span></div>
      <div><span class="cs-val">${last.rank}${ordinal(last.rank)}</span><span class="cs-lbl">Finish</span></div>
      <div><span class="cs-val">${c.titles}</span><span class="cs-lbl">Titles</span></div>
      <div><span class="cs-val ${reward.budget >= 0 ? "pos" : "neg"}">${reward.budget >= 0 ? "+" : ""}${reward.budget}</span><span class="cs-lbl">Budget</span></div>
    </div>
    <p class="career-next">Next season's budget: <strong>${Math.round(c.budget)}</strong> credits. Keep up to ${RETAIN_LIMIT} players.</p>
    <div class="retain-grid" id="retain-grid"></div>
    <button class="btn-primary" id="career-next-btn">Start Season ${c.season} →</button>`;

  const grid = panel.querySelector("#retain-grid");
  const chosen = new Set();
  state.roster.forEach((p) => {
    const card = document.createElement("button");
    card.className = "retain-card";
    card.innerHTML = `
      ${avatarHtml(p.name)}
      <div class="retain-info">
        <div class="retain-name">${p.name}</div>
        <div class="retain-sub">${p.season} · ${p.filledPosition || "Bench"} · ${getPlayerPrice(p)}cr</div>
      </div>`;
    card.addEventListener("click", () => {
      if (chosen.has(p.name)) { chosen.delete(p.name); card.classList.remove("kept"); }
      else if (chosen.size < RETAIN_LIMIT) { chosen.add(p.name); card.classList.add("kept"); }
      SFX.place();
    });
    grid.appendChild(card);
  });

  panel.querySelector("#career-next-btn").addEventListener("click", () => {
    c.retained = state.roster.filter((p) => chosen.has(p.name)).map((p) => ({ ...p, tier: undefined, filledPosition: undefined }));
    saveCareer(c);
    panel.hidden = true;
    state.career = c;
    beginCareerSeason();
  });
}

function updateCareerBanner() {
  const el = document.getElementById("career-banner");
  if (!el) return;
  const c = state.career;
  if (!c) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span class="cb-season">Season ${c.season}</span>
    <span class="cb-sep">·</span>
    <span class="cb-titles">${c.titles} title${c.titles === 1 ? "" : "s"}</span>
    <span class="cb-sep">·</span>
    <span class="cb-budget">${Math.round(c.budget)} cr</span>`;
}

function renderCareerHome() {
  const c = loadCareer();
  const block = document.getElementById("career-block");
  if (!block) return;
  if (!c) { block.hidden = true; return; }
  block.hidden = false;
  block.innerHTML = `
    <h2 class="section-title">Career in Progress</h2>
    <p class="section-sub">Season ${c.season} · ${c.titles} title${c.titles === 1 ? "" : "s"} · ${Math.round(c.budget)} credits</p>
    <div class="career-history">
      ${c.history.slice(-6).map((h) => `
        <div class="ch-row ${h.champion ? "ch-title" : ""}">
          <span class="ch-season">S${h.season}</span>
          <span class="ch-rec">${h.wins}–${h.losses}</span>
          <span class="ch-out">${h.champion ? "🏆 " : ""}${h.outcome}</span>
        </div>`).join("")}
    </div>
    <div class="career-actions">
      <button class="btn-primary" id="career-continue">Continue Career</button>
      <button class="btn-secondary" id="career-abandon">Abandon</button>
    </div>`;
  block.querySelector("#career-continue").addEventListener("click", () => {
    state.career = c;
    beginCareerSeason();
  });
  block.querySelector("#career-abandon").addEventListener("click", () => {
    clearCareer();
    state.career = null;
    renderCareerHome();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  renderCareerHome();
  const c5 = document.getElementById("career-start-5");
  const c12 = document.getElementById("career-start-12");
  if (c5) c5.addEventListener("click", () => { if (state.dataReady) startCareer("5"); });
  if (c12) c12.addEventListener("click", () => { if (state.dataReady) startCareer("12"); });
});
