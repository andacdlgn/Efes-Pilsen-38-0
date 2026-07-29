// ============================================================
// Road to Glory — Anadolu Efes All-Time Lineup
// ============================================================

const APP_VERSION = "v30";

const POSITION_ORDER = ["PG", "SG", "SF", "PF", "C"];
const POSITION_LABEL = { PG: "Point Guard (PG)", SG: "Shooting Guard (SG)", SF: "Small Forward (SF)", PF: "Power Forward (PF)", C: "Center (C)" };

const state = {
  budgetType: "unlimited", // "unlimited" | "cap"
  challenge: "none",
  freeSlotsOpen: 0,
  userSchedule: [],
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
  state.openBackupPositions = new Set(mode === "12" ? POSITION_ORDER : []);
  state.freeSlotsOpen = mode === "12" ? 2 : 0;
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
// Every slot on the roster is open from the very first pick. The draft used to
// run in strict phases (five starters, then five backups, then the bench),
// which meant a player you wanted on the bench was unplaceable if it wasn't
// yet "bench time". Now you choose where each pick goes, and starter and
// backup slots both enforce the real position — only the two extra bench
// slots take anyone.
function getCurrentTier() {
  // Kept for the few places that just need to know whether positions matter.
  return state.freeSlotsOpen > 0 || state.openPositions.size || state.openBackupPositions.size
    ? "open"
    : "full";
}

function isConstrainedPhase() {
  return state.openPositions.size > 0 || state.openBackupPositions.size > 0;
}

// Bench-only free slots don't care about position; everything else does.
function slotLabel(slot) {
  return slot.tier === "free" ? "Bench" : (slot.tier === "backup" ? "Backup " : "") + slot.pos;
}

// Where can this player legally go right now?
function availableSlotsFor(player) {
  const slots = [];
  POSITION_ORDER.forEach((pos) => {
    if (state.openPositions.has(pos) && player.positions.includes(pos)) {
      slots.push({ tier: "starter", pos });
    }
  });
  POSITION_ORDER.forEach((pos) => {
    if (state.openBackupPositions.has(pos) && player.positions.includes(pos)) {
      slots.push({ tier: "backup", pos });
    }
  });
  if (state.freeSlotsOpen > 0) slots.push({ tier: "free", pos: null });
  return slots;
}

function openSetForTier(tier) {
  if (tier === "starter") return state.openPositions;
  if (tier === "backup") return state.openBackupPositions;
  return null;
}

function slotsRemaining() {
  return state.openPositions.size + state.openBackupPositions.size + state.freeSlotsOpen;
}

// A player can currently be picked if (in cap mode) their price fits the
// remaining budget once enough credits are reserved for every slot still to
// be filled after this pick (so the cap can never dead-end the draft), and —
// only during the starter tier — at least one of their listed positions is
// still open. Backup and free-bench slots accept anyone: the 5 backup slots
// are labeled by position for bench organization, but any player can fill
// any of them, matching real fantasy-roster flexibility.
// `season` must be the season this player is being considered from. It used to
// fall back to whatever season was last spun, which meant eligibleSeasons()
// judged every candidate season against a stale one — and on the very first
// pick there was no spun season at all, so One Decade mode dead-ended.
// How many open slots still demand each position (starters + backups).
function openDemandByPosition() {
  const demand = {};
  POSITION_ORDER.forEach((pos) => {
    demand[pos] = (state.openPositions.has(pos) ? 1 : 0) + (state.openBackupPositions.has(pos) ? 1 : 0);
  });
  return demand;
}

// Everyone still available to be drafted, honouring locked seasons, challenges
// and (in cap mode) what we can still afford.
function remainingCandidates() {
  const out = [];
  const seen = new Set();
  for (const [season, list] of Object.entries(state.playersBySeason)) {
    if (state.lockedSeasons.includes(season)) continue;
    for (const p of list) {
      if (state.usedPlayerNames.has(p.name) || seen.has(p.name)) continue;
      if (!passesChallenge(p, season)) continue;
      if (state.challenge === "homegrown" && p.countryCode !== "TR") continue;
      if (state.challenge === "noLegends" && computeLegendSet().has(p.name)) continue;
      seen.add(p.name);
      out.push(p);
    }
  }
  return out;
}

// Taking this player must not strand a slot that nobody else can fill. A flat
// per-slot reserve can't see this: in a thin pool (the 1990s have exactly two
// point guards) one careless pick makes the roster impossible to complete.
function wouldStrandASlot(player, slot) {
  const demand = openDemandByPosition();
  if (slot.tier !== "free" && demand[slot.pos] > 0) demand[slot.pos]--;

  const pool = remainingCandidates().filter((p) => p.name !== player.name);
  const budgetLeft = state.budgetType === "cap"
    ? budgetRemaining() - getPlayerPrice(player)
    : Infinity;

  for (const pos of POSITION_ORDER) {
    if (demand[pos] <= 0) continue;
    const fillers = pool
      .filter((p) => p.positions.includes(pos))
      .map((p) => (state.budgetType === "cap" ? getPlayerPrice(p) : 0))
      .sort((a, b) => a - b);
    if (fillers.length < demand[pos]) return true;
    // The cheapest way to satisfy this position must still be affordable.
    const cheapest = fillers.slice(0, demand[pos]).reduce((a, b) => a + b, 0);
    if (cheapest > budgetLeft) return true;
  }
  return false;
}

function isPickable(player, season = state.currentSpinSeason) {
  if (!passesChallenge(player, season)) return false;
  const slots = availableSlotsFor(player);
  if (!slots.length) return false;
  if (state.budgetType === "cap" && getPlayerPrice(player) > budgetRemaining()) return false;
  // Pickable if at least one destination leaves the roster completable.
  return slots.some((slot) => !wouldStrandASlot(player, slot));
}

// Destinations that are actually safe to use for this player.
function safeSlotsFor(player) {
  const slots = availableSlotsFor(player);
  const safe = slots.filter((slot) => !wouldStrandASlot(player, slot));
  return safe.length ? safe : [];
}

// Seasons that have at least one undrafted, currently pickable player.
function eligibleSeasons() {
  const seasons = [];
  for (const [season, list] of Object.entries(state.playersBySeason)) {
    if (state.lockedSeasons.includes(season)) continue;
    const hasEligible = list.some((p) => !state.usedPlayerNames.has(p.name) && isPickable(p, season));
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

function openSlotsLabel() {
  const parts = [];
  const st = POSITION_ORDER.filter((p) => state.openPositions.has(p));
  const bu = POSITION_ORDER.filter((p) => state.openBackupPositions.has(p));
  if (st.length) parts.push(`Starters: ${st.join(" · ")}`);
  if (bu.length) parts.push(`Backups: ${bu.join(" · ")}`);
  if (state.freeSlotsOpen > 0) parts.push(`Bench: ${state.freeSlotsOpen} free`);
  return parts.join("   |   ") || "Roster complete";
}

function renderDraftStep() {
  const total = state.totalSlots;
  state.armedPlayer = null;
  document.getElementById("draft-progress").textContent = `PICK ${state.currentSlot + 1} / ${total}`;
  document.getElementById("draft-slot-label").textContent = openSlotsLabel();
  updateRespinCounter();
  renderCourt();
  renderBench();
  updateCourtHint();
  renderSlotRail();
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
  hint.hidden = false;
  if (state.armedPlayer) {
    const opts = safeSlotsFor(state.armedPlayer).map((o) =>
      o.tier === "free" ? "Bench" : (o.tier === "backup" ? "Backup " : "") + o.pos
    );
    hint.textContent = `Place ${state.armedPlayer.name} at ${opts.join(" / ")} — tap the lit spot.`;
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
  const positionless = false; // starter AND backup slots both enforce the real position
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
    const fits = state.armedPlayer && state.armedPlayer.positions.includes(pos);
    if (fits && openSet.has(pos)) {
      slotEl.classList.add("target-glow");
    }
  }

  slotEl.onclick = () => {
    if (occupant || !state.armedPlayer) return;
    if (state.armedPlayer.positions.includes(pos) && openSet.has(pos)) {
      const player = state.armedPlayer;
      state.armedPlayer = null;
      placePlayer(player, { tier, pos });
    }
  };

  slotEl.ondragover = (e) => {
    if (!draggedPayload) return;
    const player = draggedPayload.player;
    const fits = player.positions.includes(pos);
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
    const fits = player.positions.includes(pos);
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
    } else {
      placePlayer(player, { tier, pos });
    }
    draggedPayload = null;
  };
}

function renderCourt() {
  const wrap = document.getElementById("court-wrap");
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
      if (!draggedPayload || occupant || state.freeSlotsOpen <= 0) return;
      e.preventDefault();
      slotEl.classList.add("drag-over");
    };
    slotEl.ondragleave = () => slotEl.classList.remove("drag-over");
    slotEl.ondrop = (e) => {
      e.preventDefault();
      slotEl.classList.remove("drag-over");
      if (!draggedPayload || occupant || draggedPayload.mode !== "new") return;
      placePlayer(draggedPayload.player, { tier: "free", pos: null });
      draggedPayload = null;
    };
  });
}

function renderDraftStep_labelOnly() {
  document.getElementById("draft-slot-label").textContent = openSlotsLabel();
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
// Sorting ranks on EuroLeague output. Mixing the two competitions put domestic
// numbers — which run roughly 60% higher for the same player — above genuine
// EuroLeague production. Players with no EuroLeague minutes sort below everyone
// who has them, on their (discounted) domestic figure.
const BSL_TO_EL_DISPLAY = 0.62;

function statValue(p, stat) {
  if (p.euroleague && p.euroleague[stat] != null) return p.euroleague[stat];
  if (p.bsl && ["pts", "reb", "ast", "stl"].includes(stat) && p.bsl[stat] != null) {
    // Pushed below every EuroLeague entry, but still ordered sensibly among themselves.
    return -1000 + p.bsl[stat] * BSL_TO_EL_DISPLAY;
  }
  return -2000;
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

// Kit looks, all light-based so they read against the dark page: plain white,
// white with navy detailing, and the navy/white striped shirt. The solid navy
// kit was dropped — it disappeared into the background.
const KITS = ["kit-white", "kit-white-navy", "kit-striped"];

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
    const openMatches = safeSlotsFor(p).map((o) =>
      o.tier === "free" ? "BENCH" : (o.tier === "backup" ? "BU " : "") + o.pos
    );
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
      <div class="player-meta">${state.currentSpinSeason}${` · <span class="open-line">${openMatches.length ? "OPEN: " + openMatches.join(" / ") : "no slot available"}</span>`}</div>
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
        const opts = safeSlotsFor(p);
        if (!opts.length) return;

        // Selecting a player never places them, even when only one slot is
        // legal — confirming the position is always a separate, deliberate tap.
        // Auto-placing made a mis-tap instantly cost a pick.
        state.armedPlayer = state.armedPlayer === p ? null : p;
        renderPlayerPool(pool);
        renderCourt();
        renderBench();
        updateCourtHint();
        renderSlotRail();
        updatePlaceBar();
      });
    }

    container.appendChild(card);
  });
}

function placePlayer(player, slot) {
  // Accept either the new {tier,pos} object or a bare position string / null,
  // resolving the latter to the first legal slot for that player.
  let target = slot;
  if (typeof slot === "string" || slot == null) {
    const options = availableSlotsFor(player);
    target = slot == null
      ? (options.find((o) => o.tier === "free") || options[0])
      : (options.find((o) => o.pos === slot) || options[0]);
  }
  if (!target) return;
  const tier = target.tier;
  const filledPosition = target.pos;

  if (tier === "free") state.freeSlotsOpen--;
  else openSetForTier(tier).delete(filledPosition);
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
// - Player ratings are on a EuroLeague-equivalent scale. Turkish league output
//   is NOT treated as equal to EuroLeague output: measuring 203 same-player,
//   same-season pairs in our own data showed a player produces about 62% as
//   much in the EuroLeague as in the domestic league, so domestic numbers are
//   converted by that factor before being combined, EuroLeague games are
//   weighted more heavily, and small samples are regressed toward the mean.
// - LEAGUE_AVG_PPG (80) and LEAGUE_AVG_RATING come from real EuroLeague
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
const LEAGUE_AVG_RATING = 5.93;
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

// ============================================================
// Unified league engine
//
// Previously the season and the standings were two disconnected systems: the
// user's 38 games were rolled against one flat "league average" opponent,
// while the other clubs' records were invented separately. Nothing tied them
// together, so the table could contradict the season it was supposed to
// describe.
//
// Now a single double round-robin is played out: 20 teams, everyone home and
// away, 380 games. The user's schedule is a real one against the real 19
// opponents, the standings fall out of the same games, and the totals balance
// by construction rather than by patching afterwards.
// ============================================================
const OPP_SCALE = 2.2;        // how much a strength gap is worth in points
const HOME_COURT = 2.5;       // points of home advantage
const LEAGUE_AVG_STRENGTH = 7.04;
const MARGIN_TO_STRENGTH = 0.38;

// Convert the roster's estimated scoring margin into the same strength scale
// the real clubs are rated on, so it can be dropped straight into the league.
function rosterStrength() {
  return LEAGUE_AVG_STRENGTH + computeExpectedMargin() * MARGIN_TO_STRENGTH;
}

// Per-season form: a club's real level drifts year to year with injuries,
// signings and chemistry, so a fixed strength rating alone makes every season
// feel identical. Each side gets a season-long modifier, redrawn every run.
const SEASON_FORM_SD = 0.55;

// Home advantage isn't uniform — some arenas are genuinely harder to win at.
function homeEdgeFor(team) {
  const base = HOME_COURT;
  const bonus = team.homeFactor != null ? team.homeFactor : 0;
  return base * (1 + bonus);
}

// Score model tied to the game's competitiveness rather than a flat random gap.
// A quarter-by-quarter path to the final score, so a Final Four game can be
// watched rather than just reported. The running totals are generated to land
// exactly on the real result.
function buildGameFlow(finalScore) {
  const [us, them] = finalScore;
  const cuts = [0.26, 0.5, 0.76, 1];
  const flow = [];
  let prevA = 0, prevB = 0;
  for (let q = 0; q < 4; q++) {
    const noise = q === 3 ? 0 : (Math.random() - 0.5) * 0.06;
    const f = Math.min(1, Math.max(0.05, cuts[q] + noise));
    const a = q === 3 ? us : Math.round(us * f);
    const b = q === 3 ? them : Math.round(them * f);
    flow.push({
      quarter: q + 1,
      us: Math.max(a, prevA),
      them: Math.max(b, prevB),
    });
    prevA = flow[q].us; prevB = flow[q].them;
  }
  return flow;
}

function makeScore(edge, aWins) {
  const pace = 76 + Math.round(Math.random() * 14);
  const expected = Math.abs(edge) * 0.55;
  const gap = Math.max(1, Math.round(expected + Math.abs(gaussian()) * 6.5));
  return aWins ? [pace + gap, pace] : [pace, pace + gap];
}

function simulateLeague(userStrength) {
  const field = [
    ...state.teams.map((t) => ({
      ...t,
      s: t.strength + gaussian() * SEASON_FORM_SD,
      homeFactor: (Math.random() - 0.5) * 0.7,
      isUser: false,
    })),
    {
      name: "Anadolu Efes",
      short: "EFS",
      colors: ["#0D2C6B", "#FFFFFF"],
      strength: userStrength,
      s: userStrength,
      homeFactor: 0.15,
      isUser: true,
    },
  ];

  const rec = new Map(
    field.map((t) => [t.name, {
      wins: 0, losses: 0, pf: 0, pa: 0,
      homeW: 0, homeL: 0, awayW: 0, awayL: 0,
      beat: new Set(), lostTo: new Set(),
      h2h: new Map(),
    }])
  );
  const userSchedule = [];

  for (let i = 0; i < field.length; i++) {
    for (let j = i + 1; j < field.length; j++) {
      for (const hostIsI of [true, false]) {
        const A = field[i], B = field[j];
        const host = hostIsI ? A : B;
        const edge = (A.s - B.s) * OPP_SCALE + (hostIsI ? homeEdgeFor(host) : -homeEdgeFor(host));
        const aWins = Math.random() < pythagoreanWinPct(edge);
        const [aScore, bScore] = makeScore(edge, aWins);

        const ra = rec.get(A.name), rb = rec.get(B.name);
        ra[aWins ? "wins" : "losses"]++; rb[aWins ? "losses" : "wins"]++;
        ra.pf += aScore; ra.pa += bScore;
        rb.pf += bScore; rb.pa += aScore;

        if (hostIsI) { ra[aWins ? "homeW" : "homeL"]++; rb[aWins ? "awayL" : "awayW"]++; }
        else { ra[aWins ? "awayW" : "awayL"]++; rb[aWins ? "homeL" : "homeW"]++; }

        // Real head-to-head record, so ties can be broken the way the league does.
        ra.h2h.set(B.name, (ra.h2h.get(B.name) || 0) + (aWins ? 1 : -1));
        rb.h2h.set(A.name, (rb.h2h.get(A.name) || 0) + (aWins ? -1 : 1));

        if (A.isUser || B.isUser) {
          const userWon = A.isUser ? aWins : !aWins;
          userSchedule.push({
            opponent: A.isUser ? B : A,
            home: A.isUser ? hostIsI : !hostIsI,
            won: userWon,
            score: A.isUser ? [aScore, bScore] : [bScore, aScore],
          });
        }
      }
    }
  }

  for (let i = userSchedule.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [userSchedule[i], userSchedule[j]] = [userSchedule[j], userSchedule[i]];
  }

  const standings = field.map((t) => {
    const r = rec.get(t.name);
    return {
      ...t,
      wins: r.wins, losses: r.losses,
      diff: r.pf - r.pa, pf: r.pf, pa: r.pa,
      homeRec: `${r.homeW}-${r.homeL}`,
      awayRec: `${r.awayW}-${r.awayL}`,
      h2h: r.h2h,
    };
  });

  // EuroLeague tiebreak order: record, then head-to-head between the tied
  // teams, then overall points difference. We have the actual games, so the
  // head-to-head step uses real results rather than a proxy.
  standings.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    const h = (a.h2h.get(b.name) || 0);
    if (h !== 0) return -h;
    return b.diff - a.diff;
  });

  return { standings, userSchedule };
}

function runSimulation() {
  const league = simulateLeague(rosterStrength());
  state.standings = league.standings;
  state.userSchedule = league.userSchedule;

  const results = league.userSchedule.map((g) => (g.won ? "W" : "L"));
  const wins = results.filter((r) => r === "W").length;
  return { results, wins, losses: 38 - wins, avgP: wins / 38 };
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
    const fixture = state.userSchedule && state.userSchedule[i];
    cells[i].textContent = res;
    cells[i].title = fixture
      ? `Game ${i + 1} ${fixture.home ? "vs" : "at"} ${fixture.opponent.name}: ${res} ${fixture.score[0]}–${fixture.score[1]}`
      : `Game ${i + 1}: ${res}`;
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
// Playoff games run on exactly the same maths as the regular season: the gap
// between two strength ratings, plus home court. Using a different formula
// here was why a side could dominate the league and then look unrecognisable
// in the postseason.
function winProbVs(margin, opponent, atHome) {
  const mine = LEAGUE_AVG_STRENGTH + margin * MARGIN_TO_STRENGTH;
  const theirs = opponent.strength != null ? opponent.strength : LEAGUE_AVG_STRENGTH;
  return pythagoreanWinPct((mine - theirs) * OPP_SCALE + (atHome ? HOME_COURT : -HOME_COURT));
}

// Real EuroLeague home pattern for a best-of-five: games 1, 2 and 5 belong to
// the higher-seeded side. Home court is worth roughly a 3-point swing.
const HOME_GAMES_BO5 = [1, 2, 5];

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
    const p = winProbVs(margin, opponent, atHome);
    const won = Math.random() < p;
    const score = simGameScore(p, won);
    games.push({ won, atHome, score, flow: buildGameFlow(score) });
    if (won) w++; else l++;
  }
  return { opponent, games, w, l, won: w >= needed, bestOf, userHasHomeCourt };
}

let lastPlayoffChampion = false;
let lastPlayoffFinish = "";

// Seeds the bracket from the final table: the user meets progressively better
// opposition, drawn from the actual standings rather than fixed placeholders.
// The eight-team bracket is built once, up front, and everything else reads
// from it — so the opponent shown in the user's series is by definition the
// same one shown in the bracket. (They used to be derived separately, which is
// why they could disagree.)
const BRACKET_PAIRS = [[1, 8], [4, 5], [2, 7], [3, 6]];

let currentBracket = null;

function seedPlayoffField() {
  const sorted = [...state.standings].sort((a, b) => b.wins - a.wins || b.diff - a.diff);
  return sorted.slice(0, 8).map((t, i) => ({ ...t, seed: i + 1 }));
}

// A neutral series simulation between two AI sides, returning a real series score.
function simAiSeries(a, b, bestOf) {
  // Same engine as everything else: strength gap plus home court for the
  // better-seeded side.
  const sa = a.strength != null ? a.strength : LEAGUE_AVG_STRENGTH;
  const sb = b.strength != null ? b.strength : LEAGUE_AVG_STRENGTH;
  const p = pythagoreanWinPct((sa - sb) * OPP_SCALE + HOME_COURT * 0.5);
  let w = 0, l = 0;
  const needed = Math.ceil(bestOf / 2);
  while (w < needed && l < needed) {
    if (Math.random() < p) w++; else l++;
  }
  return { winner: w >= needed ? a : b, loser: w >= needed ? b : a, score: [Math.max(w, l), Math.min(w, l)] };
}

function buildBracket(userRank) {
  const field = seedPlayoffField();
  const bySeed = (n) => field.find((t) => t.seed === n);
  const ties = BRACKET_PAIRS.map(([hi, lo]) => ({ a: bySeed(hi), b: bySeed(lo) })).filter((t) => t.a && t.b);
  const userTie = ties.find((t) => t.a.isUser || t.b.isUser);
  currentBracket = { field, ties, userTie };
  return currentBracket;
}

// The user's route through the bracket: quarterfinal from their own tie, then
// the survivors of the other half.
function opponentsFromBracket(userRank) {
  const bk = currentBracket || buildBracket(userRank);
  const fallback = bk.field.filter((t) => !t.isUser);
  const qf = bk.userTie ? (bk.userTie.a.isUser ? bk.userTie.b : bk.userTie.a) : fallback[0];

  const others = bk.ties.filter((t) => t !== bk.userTie);
  const semiPool = others.map((t) => (t.a.wins >= t.b.wins ? t.a : t.b));
  const ranked = [...fallback].sort((a, b) => b.wins - a.wins);
  return {
    qf,
    sf: semiPool[0] || ranked[0],
    final: semiPool[1] || ranked[1] || ranked[0],
    third: semiPool[2] || ranked[2] || ranked[0],
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

  buildBracket(userRank);
  const opp = opponentsFromBracket(userRank);
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
    if (el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "nearest" });

    const gamesEl = el.querySelector(".pr-games");
    const tallyEl = el.querySelector(".pr-tally");
    const resEl = el.querySelector(".pr-res");
    let gi = 0, w = 0, l = 0;

    // Final Four ties are single games and carry the weight of the season, so
    // they play out quarter by quarter on a live scoreboard instead of simply
    // printing the result.
    function revealLiveGame(g, done) {
      const board = document.createElement("div");
      board.className = "live-game";
      board.innerHTML = `
        <div class="lg-teams">
          <span class="lg-side">EFES</span>
          <span class="lg-score" id="lg-score">0 – 0</span>
          <span class="lg-side">${r.opponent.short}</span>
        </div>
        <div class="lg-quarter" id="lg-quarter">TIP-OFF</div>
        <div class="lg-bar"><span id="lg-bar-fill"></span></div>`;
      gamesEl.appendChild(board);
      const scoreEl = board.querySelector("#lg-score");
      const qEl = board.querySelector("#lg-quarter");
      const barEl = board.querySelector("#lg-bar-fill");

      let qi = 0;
      const tick = () => {
        if (qi >= g.flow.length) {
          board.classList.add(g.won ? "lg-won" : "lg-lost");
          qEl.textContent = g.won ? "FINAL — WON" : "FINAL — LOST";
          done();
          return;
        }
        const f = g.flow[qi];
        scoreEl.textContent = `${f.us} – ${f.them}`;
        scoreEl.className = "lg-score " + (f.us >= f.them ? "ahead" : "behind");
        qEl.textContent = qi === 3 ? "4TH QUARTER" : `${["1ST", "2ND", "3RD"][qi]} QUARTER`;
        barEl.style.width = ((qi + 1) / 4) * 100 + "%";
        SFX.spin();
        qi++;
        setTimeout(tick, 900);
      };
      setTimeout(tick, 500);
    }

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

      if (r.bestOf === 1 && r.title.startsWith("Final Four") && g.flow) {
        gi++;
        revealLiveGame(g, () => setTimeout(revealGame, 700));
        return;
      }

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
    try { renderBracket(userRank, sequence.find((r) => r.title === "Quarterfinal")); } catch (e) { console.error("bracket failed", e); }
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
  legendNameSet = new Set(HALL_OF_LEGENDS.map((L) => L.name));
  return legendNameSet;
}

function decadeOf(season) {
  if (!season) return null;
  const year = parseInt(String(season).split("-")[0], 10);
  return Number.isFinite(year) ? Math.floor(year / 10) * 10 : null;
}

// Returns true if this player is allowed under the active challenge.
function passesChallenge(player, season) {
  switch (state.challenge) {
    case "singleEra": {
      if (state.lockedDecade == null) return true;
      const dec = decadeOf(season);
      return dec === null || dec === state.lockedDecade;
    }
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
// ============================================================
// Hall of Legends
//
// This is a curated honour roll, not a leaderboard. Ranking players against
// each other produced nonsense — a productive three-year spell outranking
// people who won the club its trophies, or a squad member from a title team
// sitting above a 1990s icon. Every name here is presented as equal.
//
// The foreign contingent follows Eurohoops' feature on the ten most important
// foreign players in Anadolu Efes history. The Turkish names are the club's
// own landmark figures. Several of the earliest have no recorded per-game
// statistics at all — which is precisely why a stats-driven ranking could
// never have represented them.
// ============================================================
const HALL_OF_LEGENDS = [
  // — Eurohoops' ten most important foreign players —
  { name: "Petar Naumoski", years: "1992–94, 1995–99", note: "The playmaker who defined the club's 1990s peak", group: "foreign" },
  { name: "Conrad McRae", years: "1995–96", note: "Central to the 1996 Korać Cup, Turkey's first European trophy", group: "foreign" },
  { name: "Larry Richard", years: "1992–95", note: "Cornerstone of the side that reached the 1993 final", group: "foreign" },
  { name: "Marcus Brown", years: "2001–03", note: "League MVP and All-EuroLeague Second Team", group: "foreign" },
  { name: "Kaspars Kambala", years: "2001–03", note: "Dominant interior force of the title-winning years", group: "foreign" },
  { name: "Nikola Prkacin", years: "2003–07", note: "Captain and the club's cerebral playmaking big", group: "foreign" },
  { name: "Antonio Granger", years: "2002–04, 2005–07", note: "Club's all-time EuroLeague three-point leader", group: "foreign" },
  { name: "Bryant Dunston", years: "2016–23", note: "Defensive anchor of both EuroLeague titles", group: "foreign" },
  { name: "Shane Larkin", years: "2018–", note: "EuroLeague scoring record holder, two-time champion", group: "foreign" },
  { name: "Vasilije Micic", years: "2018–23", note: "EuroLeague MVP and twice Final Four MVP", group: "foreign" },
  { name: "Krunoslav Simon", years: "2018–23", note: "Versatile wing and a starter in both EuroLeague title runs", group: "foreign" },

  // — Turkish landmark figures —
  { name: "Hidayet Türkoğlu", years: "1996–2000", note: "Academy product who became Turkey's first NBA star", group: "turkish" },
  { name: "Mehmet Okur", years: "2000–02", note: "Went from Efes to an NBA All-Star selection", group: "turkish" },
  { name: "Mirsad Türkcan", years: "1996–98, 2008–10", note: "Relentless rebounder and Korać Cup era mainstay", group: "turkish" },
  { name: "Hüseyin Beşok", years: "1998–2002", note: "Anchor of the Final Four sides at the turn of the century", group: "turkish" },
  { name: "Kerem Tunceri", years: "2001–03, 2009–13", note: "Two spells, a decade apart, always the steady hand", group: "turkish" },
  { name: "Kerem Gonlum", years: "2005–13", note: "Long-serving captain and dressing-room leader", group: "turkish" },
  { name: "Ömer Onan", years: "1998–2002", note: "Homegrown wing of the club's European breakthrough", group: "turkish" },
  { name: "Cedi Osman", years: "2011–17", note: "Academy graduate who left for the NBA", group: "turkish" },
  { name: "Doğuş Balbay", years: "2013–22", note: "Defensive specialist across the championship era", group: "turkish" },
];

// Attach whatever recorded statistics we actually have to each legend.
function legendStats(name) {
  let seasons = 0, gp = 0, weighted = 0, peak = null;
  for (const [season, list] of Object.entries(state.playersBySeason)) {
    const p = list.find((x) => x.name === name);
    if (!p) continue;
    const games =
      (p.euroleague ? parseInt(p.euroleague.gp) || 0 : 0) +
      (p.bsl ? parseInt(p.bsl.gp) || 0 : 0);
    seasons++; gp += games; weighted += p.rating * games;
    if (!peak || peak.rating < p.rating) peak = { rating: p.rating, season };
    if (p.countryCode) legendStats._flag = p.countryCode;
  }
  return { seasons, gp, avg: gp ? weighted / gp : 0, peak };
}

function renderLegends() {
  const grid = document.getElementById("legends-grid");
  if (!grid) return;
  grid.innerHTML = "";

  HALL_OF_LEGENDS.forEach((L) => {
    const st = legendStats(L.name);
    const el = document.createElement("div");
    el.className = "legend-tile" + (st.gp ? "" : " legend-noclick");
    el.innerHTML = `
      <div class="lt-badge">${L.group === "foreign" ? "INTERNATIONAL" : "TÜRKİYE"}</div>
      <div class="lt-avatar">${avatarHtml(L.name)}</div>
      <div class="lt-name">${L.name}</div>
      <div class="lt-years">${L.years}</div>
      <div class="lt-note">${L.note}</div>
      <div class="lt-foot">
        ${st.gp
          ? `<span class="lt-stat"><b>${st.seasons}</b> seasons</span><span class="lt-stat"><b>${st.gp}</b> games</span>`
          : `<span class="lt-stat lt-nostat">Pre-1997 · no box scores recorded</span>`}
      </div>`;
    if (st.gp) el.addEventListener("click", () => openPlayerModal(L.name));
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
  if (typeof window.matchMedia !== "function") return window.innerWidth <= 860;
  return window.matchMedia("(max-width: 860px)").matches;
}

function slotsPlayerCanFill(player) {
  return safeSlotsFor(player);
}

// ---------- Mobile: position picker sheet ----------
// Phones drop the court entirely. Tapping a player opens a sheet listing every
// slot on the roster, so a pick is two taps with no scrolling and no dragging.
function updatePlaceBar() {
  const sheet = document.getElementById("pick-sheet");
  if (!sheet) return;
  const p = state.armedPlayer;
  if (!p || !isMobileViewport()) { sheet.hidden = true; return; }

  document.getElementById("pick-sheet-title").innerHTML =
    `<span class="ps-name">${p.name}</span><span class="ps-sub">${state.currentSpinSeason} · ${p.positions.join(" / ")}</span>`;

  const safe = safeSlotsFor(p);
  const canGo = (tier, pos) =>
    safe.find((sl) => sl.tier === tier && sl.pos === pos);

  const occupantOf = (tier, pos) =>
    state.roster.find((r) => r.tier === tier && r.filledPosition === pos);

  function tile(tier, pos) {
    const slot = canGo(tier, pos);
    const occ = occupantOf(tier, pos);
    const state_ = occ ? "taken" : slot ? "open" : "blocked";
    const sub = occ
      ? occ.name.split(" ").slice(-1)[0]
      : slot ? "AVAILABLE" : "N/A";
    return `<button class="ps-tile ps-${state_}" data-tier="${tier}" data-pos="${pos}" ${slot ? "" : "disabled"}>
      <span class="ps-pos">${pos}</span><span class="ps-state">${sub}</span></button>`;
  }

  const freeSlot = safe.find((sl) => sl.tier === "free");
  const freeUsed = state.roster.filter((r) => r.tier === "free").length;

  let html = `<div class="ps-group-label">Starting Five</div>
    <div class="ps-row">${POSITION_ORDER.map((pos) => tile("starter", pos)).join("")}</div>`;

  if (state.mode === "12") {
    html += `<div class="ps-group-label">Bench — Backups</div>
      <div class="ps-row">${POSITION_ORDER.map((pos) => tile("backup", pos)).join("")}</div>
      <div class="ps-group-label">Bench — Any Position</div>
      <div class="ps-row ps-row-free">
        <button class="ps-tile ps-wide ${freeSlot ? "ps-open" : "ps-blocked"}" data-tier="free" ${freeSlot ? "" : "disabled"}>
          <span class="ps-pos">BENCH</span><span class="ps-state">${freeUsed}/2 used</span>
        </button>
      </div>`;
  }

  const body = document.getElementById("pick-sheet-body");
  body.innerHTML = html;
  body.querySelectorAll(".ps-tile:not([disabled])").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tier = btn.dataset.tier;
      const pos = btn.dataset.pos || null;
      const player = state.armedPlayer;
      state.armedPlayer = null;
      sheet.hidden = true;
      placePlayer(player, { tier, pos });
    });
  });

  sheet.hidden = false;
}

function closePickSheet() {
  const sheet = document.getElementById("pick-sheet");
  if (sheet) sheet.hidden = true;
  state.armedPlayer = null;
  renderPlayerPool(state.currentSpinPool);
  renderCourt();
  renderBench();
  updateCourtHint();
  renderSlotRail();
}

// A always-visible rail so the phone user can see the roster taking shape.
function renderSlotRail() {
  const rail = document.getElementById("slot-rail");
  if (!rail) return;
  if (!isMobileViewport() || !state.mode || state.currentSlot >= state.totalSlots) {
    rail.hidden = true;
    return;
  }
  const cell = (tier, pos) => {
    const occ = state.roster.find((r) => r.tier === tier && r.filledPosition === pos);
    return `<div class="rail-cell ${occ ? "filled" : ""}">
      <span class="rail-pos">${pos}</span>
      <span class="rail-name">${occ ? occ.name.split(" ").slice(-1)[0] : "—"}</span>
    </div>`;
  };
  let html = `<div class="rail-row">${POSITION_ORDER.map((p) => cell("starter", p)).join("")}</div>`;
  if (state.mode === "12") {
    const freeUsed = state.roster.filter((r) => r.tier === "free").length;
    html += `<div class="rail-row rail-row-bench">${POSITION_ORDER.map((p) => cell("backup", p)).join("")}
      <div class="rail-cell ${freeUsed ? "filled" : ""}"><span class="rail-pos">BN</span><span class="rail-name">${freeUsed}/2</span></div></div>`;
  }
  rail.innerHTML = html;
  rail.hidden = false;
}


document.addEventListener("DOMContentLoaded", () => {
  const closeBtn = document.getElementById("pick-sheet-close");
  if (closeBtn) closeBtn.addEventListener("click", closePickSheet);
  const sheet = document.getElementById("pick-sheet");
  if (sheet) sheet.addEventListener("click", (e) => { if (e.target === sheet) closePickSheet(); });

  window.addEventListener("resize", () => {
      renderSlotRail();
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

function buildStandings() {
  // The table is simply the league we already played out.
  return state.standings || [];
}

function renderStandings(userWins) {
  const el = document.getElementById("standings-table");
  if (!el) return;
  const rows = buildStandings();
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
        <span class="st-split" title="Home / Away">${r.homeRec || ""} <i>/</i> ${r.awayRec || ""}</span>
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
function renderBracket(userRank, userSeriesResult) {
  const el = document.getElementById("bracket-grid");
  if (!el) return;
  const bk = currentBracket || buildBracket(userRank);

  // Resolve every quarterfinal: the user's is the series they actually played,
  // the rest are simulated, and each carries a real series score.
  const results = bk.ties.map((tie) => {
    if (tie === bk.userTie && userSeriesResult) {
      const user = tie.a.isUser ? tie.a : tie.b;
      const other = tie.a.isUser ? tie.b : tie.a;
      const won = userSeriesResult.won;
      return {
        tie,
        winner: won ? user : other,
        score: won ? [userSeriesResult.w, userSeriesResult.l] : [userSeriesResult.l, userSeriesResult.w],
      };
    }
    const r = simAiSeries(tie.a, tie.b, 5);
    return { tie, winner: r.winner, score: r.score };
  });

  const teamRow = (team, isWinner, score) => `
    <div class="bk-team ${isWinner ? "bk-win" : "bk-out"} ${team.isUser ? "bk-user" : ""}">
      <span class="bk-seed">${team.seed}</span>
      <span class="st-badge" style="background:${team.colors[0]};color:${team.colors[1]}">${team.short}</span>
      <span class="bk-name">${team.name}</span>
      <span class="bk-series">${score}</span>
    </div>`;

  el.innerHTML = `
    <div class="bracket-round">
      <div class="bracket-round-label">Quarterfinals · best of 5</div>
      ${results.map((r) => {
        const aWon = r.winner === r.tie.a;
        return `<div class="bk-tie">
          ${teamRow(r.tie.a, aWon, aWon ? r.score[0] : r.score[1])}
          ${teamRow(r.tie.b, !aWon, aWon ? r.score[1] : r.score[0])}
        </div>`;
      }).join("")}
    </div>
    <div class="bracket-connector"></div>
    <div class="bracket-round">
      <div class="bracket-round-label">Final Four</div>
      ${results.map((r) => `
        <div class="bk-advance ${r.winner.isUser ? "bk-user" : ""}">
          <span class="st-badge" style="background:${r.winner.colors[0]};color:${r.winner.colors[1]}">${r.winner.short}</span>
          <span class="bk-name">${r.winner.name}</span>
        </div>`).join("")}
    </div>`;
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
  state.openBackupPositions = new Set(d.mode === "12" ? POSITION_ORDER : []);
  state.freeSlotsOpen = d.mode === "12" ? 2 : 0;
  state.roster.forEach((p) => {
    if (p.tier === "starter" && p.filledPosition) state.openPositions.delete(p.filledPosition);
    if (p.tier === "backup" && p.filledPosition) state.openBackupPositions.delete(p.filledPosition);
    if (p.tier === "free") state.freeSlotsOpen--;
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
      const options = availableSlotsFor(p);
      if (!options.length) return;
      state.currentSpinSeason = p.season;
      placePlayer(p, options[0]);
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
