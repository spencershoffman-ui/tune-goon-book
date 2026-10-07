// Tune and Goon Book frontend — vanilla JS, no build step.
// Session (user id + token) lives in localStorage so the book remembers you.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtOdds = (o) => (o > 0 ? "+" + o : String(o));
const fmtGB = (n) => Number(n).toFixed(2) + " GB";

let STATE = null;
let session = JSON.parse(localStorage.getItem("tgb_session") || "null");
let boardSel = {};   // matchupId -> 'a'|'b'
let propSel = {};    // propId -> 'a'|'b'
let pickSel = {};    // matchupId -> 'a'|'b'
let settleSel = { matchups: {}, props: {} };
let settleWeekId = null;       // week selected for settling in the commish tab (null = auto)
let settleWeekData = null;     // {week, matchups, props} when settling a non-open week
let settleWeekDataLoading = false;
let commishAuthed = sessionStorage.getItem("tgb_commish") === "1";

// ---------- tabs ----------
$("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (!btn) return;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  btn.classList.add("active");
  $("tab-" + btn.dataset.tab).classList.add("active");
});

// ---------- api ----------
async function api(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (session) headers["X-User-Token"] = session.token;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

// ---------- join ----------
function maybeShowJoin() {
  if (session || !STATE) return;
  const claimed = new Set(STATE.users.map((u) => u.team_name));
  const open = STATE.teams.filter((t) => !claimed.has(t));
  if (!open.length) return; // league full
  $("joinTeam").innerHTML = open.map((t) => `<option>${esc(t)}</option>`).join("");
  $("joinModal").style.display = "flex";
}

$("joinBtn").addEventListener("click", async () => {
  $("joinError").textContent = "";
  try {
    const data = await api("POST", "/api/join", { team_name: $("joinTeam").value });
    session = { id: data.id, team_name: data.team_name, token: data.token };
    localStorage.setItem("tgb_session", JSON.stringify(session));
    $("joinModal").style.display = "none";
    await refresh();
  } catch (e) { $("joinError").textContent = e.message; }
});

// ---------- render ----------
function myUser() {
  return session && STATE ? STATE.users.find((u) => u.id === session.id) : null;
}

function renderHeader() {
  const me = myUser();
  if (me) {
    $("bankrollBar").style.display = "flex";
    $("whoAmI").textContent = me.team_name;
    $("myBankroll").textContent = fmtGB(me.bankroll);
  } else {
    $("bankrollBar").style.display = "none";
  }
}

function renderBoard() {
  const el = $("board");
  const w = STATE.week;
  if (!w) { el.innerHTML = `<div class="card"><h2>No open week</h2><p class="note">The commish hasn't opened a betting week yet.</p></div>`; return; }
  const locked = w.status !== "open";
  let html = `<div class="card"><h2>Week ${w.week_number} Lines ${locked ? '<span class="badge open">locked</span>' : ""}</h2>`;
  for (const m of STATE.matchups) {
    const sel = boardSel[m.id];
    html += `<div class="matchup">
      <div class="teams">
        <button class="side ${sel === "a" ? "selected" : ""}" data-m="${m.id}" data-side="a" ${locked || !session ? "disabled" : ""}>${esc(m.team_a)}<span class="odds">${fmtOdds(m.odds_a)}</span></button>
        <button class="side ${sel === "b" ? "selected" : ""}" data-m="${m.id}" data-side="b" ${locked || !session ? "disabled" : ""}>${esc(m.team_b)}<span class="odds">${fmtOdds(m.odds_b)}</span></button>
      </div>
      ${sel && !locked && session ? `<div class="bet-row"><input type="number" min="1" step="0.01" inputmode="decimal" placeholder="Stake (GB)" id="stake-${m.id}"><button data-place="${m.id}">Bet ${esc(sel === "a" ? m.team_a : m.team_b)}</button></div><div class="error" id="err-${m.id}"></div>` : ""}
    </div>`;
  }
  html += locked ? `<p class="note">This week is locked — no more bets.</p>` : (!session ? `<p class="note">Join the book to place bets.</p>` : "");
  html += `</div>`;
  el.innerHTML = html;

  el.querySelectorAll(".side[data-m]").forEach((b) => b.addEventListener("click", () => {
    boardSel[b.dataset.m] = b.dataset.side;
    renderBoard();
  }));
  el.querySelectorAll("[data-place]").forEach((b) => b.addEventListener("click", async () => {
    const mid = b.dataset.place;
    const stake = $("stake-" + mid).value;
    const errEl = $("err-" + mid);
    errEl.textContent = "";
    try {
      await api("POST", "/api/bets", { user_id: session.id, matchup_id: Number(mid), side: boardSel[mid], stake });
      delete boardSel[mid];
      await refresh();
    } catch (e) { errEl.textContent = e.message; }
  }));
}

function betLabel(b) {
  const m = STATE.matchups.find((x) => x.id === b.matchup_id);
  if (!m) return "Game bet";
  return b.side === "a" ? m.team_a : m.team_b;
}
function propBetLabel(b) {
  const p = STATE.props.find((x) => x.id === b.prop_id);
  if (!p) return "Prop bet";
  return p.label + " — " + (b.side === "a" ? p.option_a : p.option_b);
}

function renderBetsFeed() {
  const el = $("betsFeed");
  const all = [
    ...STATE.bets.map((b) => ({ ...b, label: betLabel(b), kind: "Game" })),
    ...STATE.propBets.map((b) => ({ ...b, label: propBetLabel(b), kind: "Prop" })),
  ];
  let html = `<div class="card"><h2>🎟️ Everyone's Bets — Week ${STATE.week ? STATE.week.week_number : "–"}</h2>`;
  if (!all.length) html += `<p class="note">No bets placed yet. Be the first degenerate (fake money only).</p>`;
  html += `<div class="bet-feed">` + all.map((b) => `
    <div class="row">
      <div><b>${esc(b.team_name)}</b> <span class="note">${b.kind}</span><br><span class="note">${esc(b.label)} (${fmtOdds(b.odds)}) · ${fmtGB(b.stake)}</span></div>
      <div><span class="badge ${b.status}">${b.status}${b.status === "won" && b.payout ? " +" + fmtGB(b.payout) : ""}</span></div>
    </div>`).join("") + `</div></div>`;
  el.innerHTML = html;
}

function renderPickem() {
  const el = $("pickem");
  const w = STATE.week;
  if (!w) { el.innerHTML = `<div class="card"><h2>Pick'em</h2><p class="note">No open week.</p></div>`; return; }
  const locked = w.status !== "open";
  const mine = session ? STATE.pickems.find((p) => p.user_id === session.id) : null;
  let html = `<div class="card"><h2>✅ Pick'em — Week ${w.week_number}</h2>
    <p class="note">Pick all ${STATE.matchups.length} winners. Tiebreaker: total points scored across all matchups. Most correct picks wins <b>200 Goon Bucks</b>.</p>`;
  for (const m of STATE.matchups) {
    const sel = pickSel[m.id] ?? (mine ? JSON.parse(mine.picks).find((p) => p.matchup_id === m.id)?.side : null);
    html += `<div class="pick-row">
      <button data-pick="${m.id}" data-side="a" class="${sel === "a" ? "picked" : ""}" ${locked || !session ? "disabled" : ""}>${esc(m.team_a)}</button>
      <span class="vs">vs</span>
      <button data-pick="${m.id}" data-side="b" class="${sel === "b" ? "picked" : ""}" ${locked || !session ? "disabled" : ""}>${esc(m.team_b)}</button>
    </div>`;
  }
  if (!locked && session) {
    const tb = mine ? mine.tiebreaker : "";
    html += `<div class="field"><label>Tiebreaker — total points, all matchups</label><input type="number" min="0" id="tiebreaker" value="${tb}" placeholder="e.g. 1040"></div>
    <button id="savePicks" class="gold" style="width:100%">${mine ? "Update picks" : "Lock in picks"}</button>
    <div class="error" id="pickErr"></div><div class="success" id="pickOk"></div>`;
  }
  html += `</div><div class="card"><h2>Entries</h2><div class="bet-feed">`;
  if (!STATE.pickems.length) html += `<p class="note">Nobody's picked yet.</p>`;
  for (const p of STATE.pickems) {
    const picks = JSON.parse(p.picks);
    const desc = picks.map((pk) => {
      const m = STATE.matchups.find((x) => x.id === pk.matchup_id);
      return m ? (pk.side === "a" ? m.team_a : m.team_b) : "?";
    }).join(" · ");
    const score = p.correct !== null && p.correct !== undefined
      ? ` <span class="badge ${p.correct >= 4 ? "won" : "open"}">${p.correct}/5${p.tiebreak_diff !== null && p.tiebreak_diff !== undefined ? ` · TB off by ${p.tiebreak_diff}` : ""}</span>` : "";
    html += `<div class="row"><div><b>${esc(p.team_name)}</b><br><span class="note">${esc(desc)} · TB ${esc(p.tiebreaker)}</span></div><div>${score}</div></div>`;
  }
  html += `</div></div>`;
  el.innerHTML = html;

  el.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => {
    pickSel[b.dataset.pick] = b.dataset.side;
    renderPickem();
  }));
  const save = $("savePicks");
  if (save) save.addEventListener("click", async () => {
    $("pickErr").textContent = ""; $("pickOk").textContent = "";
    try {
      const picks = STATE.matchups.map((m) => {
        const side = pickSel[m.id] ?? (mine ? JSON.parse(mine.picks).find((p) => p.matchup_id === m.id)?.side : null);
        return { matchup_id: m.id, side };
      });
      await api("POST", "/api/pickem", { user_id: session.id, picks, tiebreaker: $("tiebreaker").value });
      pickSel = {};
      $("pickOk").textContent = "Picks locked in. Good luck.";
      await refresh();
    } catch (e) { $("pickErr").textContent = e.message; }
  });
}

function renderProps() {
  const el = $("props");
  const w = STATE.week;
  if (!w) { el.innerHTML = `<div class="card"><h2>Prop Sheet</h2><p class="note">No open week.</p></div>`; return; }
  const locked = w.status !== "open";
  let html = `<div class="card"><h2>🎲 Prop Sheet — Week ${w.week_number}</h2>`;
  for (const p of STATE.props) {
    const sel = propSel[p.id];
    html += `<div class="matchup"><div class="note" style="padding:8px 10px 0"><b>${esc(p.label)}</b></div>
      <div class="teams">
        <button class="side ${sel === "a" ? "selected" : ""}" data-p="${p.id}" data-side="a" ${locked || !session ? "disabled" : ""}>${esc(p.option_a)}<span class="odds">${fmtOdds(p.odds_a)}</span></button>
        <button class="side ${sel === "b" ? "selected" : ""}" data-p="${p.id}" data-side="b" ${locked || !session ? "disabled" : ""}>${esc(p.option_b)}<span class="odds">${fmtOdds(p.odds_b)}</span></button>
      </div>
      ${sel && !locked && session ? `<div class="bet-row"><input type="number" min="1" step="0.01" inputmode="decimal" placeholder="Stake (GB)" id="pstake-${p.id}"><button data-pplace="${p.id}">Bet</button></div><div class="error" id="perr-${p.id}"></div>` : ""}
    </div>`;
  }
  html += `</div>`;
  el.innerHTML = html;
  el.querySelectorAll(".side[data-p]").forEach((b) => b.addEventListener("click", () => {
    propSel[b.dataset.p] = b.dataset.side;
    renderProps();
  }));
  el.querySelectorAll("[data-pplace]").forEach((b) => b.addEventListener("click", async () => {
    const pid = b.dataset.pplace;
    const errEl = $("perr-" + pid);
    errEl.textContent = "";
    try {
      await api("POST", "/api/prop-bets", { user_id: session.id, prop_id: Number(pid), side: propSel[pid], stake: $("pstake-" + pid).value });
      delete propSel[pid];
      await refresh();
    } catch (e) { errEl.textContent = e.message; }
  }));
}

function renderLeaderboard() {
  const el = $("leaderboard");
  let html = `<div class="card"><h2>🏆 Goon Bucks Leaderboard</h2><table class="board">
    <tr><th>#</th><th>Team</th><th style="text-align:right">Bankroll</th></tr>`;
  STATE.users.forEach((u, i) => {
    html += `<tr class="${i === 0 ? "leader" : ""}"><td>${i + 1}</td><td>${esc(u.team_name)}${session && u.id === session.id ? " (you)" : ""}</td><td class="num">${fmtGB(u.bankroll)}</td></tr>`;
  });
  html += `</table><p class="note">Everyone started with 1,000 Goon Bucks (fake).</p></div>`;

  // Pick'em standings for the current week (scored after commish settles).
  if (STATE.week && STATE.pickems.some((p) => p.correct !== null && p.correct !== undefined)) {
    const scored = [...STATE.pickems].sort((a, b) => (b.correct - a.correct) || (Number(a.tiebreak_diff) - Number(b.tiebreak_diff)));
    html += `<div class="card"><h2>✅ Pick'em Standings — Week ${STATE.week.week_number}</h2><table class="board">
      <tr><th>#</th><th>Team</th><th style="text-align:right">Correct</th><th style="text-align:right">TB diff</th></tr>`;
    scored.forEach((p, i) => {
      html += `<tr class="${i === 0 ? "leader" : ""}"><td>${i + 1}</td><td>${esc(p.team_name)}</td><td class="num">${p.correct}/5</td><td class="num">${p.tiebreak_diff}</td></tr>`;
    });
    html += `</table></div>`;
  }
  el.innerHTML = html;
}

function renderCommish() {
  const el = $("commish");
  if (!commishAuthed) {
    el.innerHTML = `<div class="card"><h2>🔐 Commish Only</h2>
      <p class="note">Settling weeks and opening new ones needs the commish passcode.</p>
      <div class="field"><label>Passcode</label><input type="password" id="passcode" inputmode="numeric"></div>
      <div class="error" id="commErr"></div>
      <button id="unlockBtn">Unlock</button></div>`;
    $("unlockBtn").addEventListener("click", () => {
      if ($("passcode").value === "10502") {
        commishAuthed = true;
        sessionStorage.setItem("tgb_commish", "1");
        renderCommish();
      } else {
        $("commErr").textContent = "Wrong passcode.";
      }
    });
    return;
  }

  const w = STATE.week;
  let html = `<div class="card"><h2>🔐 Commish Panel</h2>`;
  // Settle any unsettled week (open or locked) — so opening a new week never
  // strands an older one.
  const settleable = STATE.weeks.filter((x) => x.status !== "settled");
  const openId = w && w.status === "open" ? w.id : null;
  if (settleWeekId == null || !settleable.some((x) => x.id === settleWeekId)) {
    settleWeekId = openId || (settleable.length ? settleable[settleable.length - 1].id : null);
    settleSel = { matchups: {}, props: {} };
    settleWeekData = null;
    settleWeekDataLoading = false;
  }
  if (!settleable.length) {
    html += `<p class="note">Every week is settled. Open a new week below.</p>`;
  } else {
    const needRemote = settleWeekId !== openId;
    if (needRemote && !settleWeekData && !settleWeekDataLoading) {
      settleWeekDataLoading = true;
      api("GET", "/api/week/" + settleWeekId)
        .then((d) => { settleWeekData = d; })
        .catch(() => {})
        .finally(() => { settleWeekDataLoading = false; renderCommish(); });
    }
    const sw = needRemote ? settleWeekData : { week: w, matchups: STATE.matchups, props: STATE.props };
    html += `<h3 style="color:var(--green)">Settle a Week</h3>
      <div class="field"><label>Week to settle</label><select id="settleWeekSel">` +
      settleable.map((x) => `<option value="${x.id}"${x.id === settleWeekId ? " selected" : ""}>Week ${x.week_number}${x.id === openId ? " (current)" : " (locked)"}</option>`).join("") +
      `</select></div>`;
    if (needRemote && !sw) {
      html += `<p class="note">Loading week…</p>`;
    } else {
      html += `<p class="note">Mark every winner, then settle. This pays out all bets, scores pick'ems, and awards 200 GB to the best pick'em. Can't be undone.</p>`;
      for (const m of sw.matchups) {
        const s = settleSel.matchups[m.id];
        html += `<div class="field"><label>${esc(m.team_a)} vs ${esc(m.team_b)}</label>
          <div class="settle-grid">
            <button data-sm="${m.id}" data-side="a" class="${s === "a" ? "picked" : ""}">${esc(m.team_a)} wins</button>
            <button data-sm="${m.id}" data-side="b" class="${s === "b" ? "picked" : ""}">${esc(m.team_b)} wins</button>
          </div></div>`;
      }
      for (const p of sw.props) {
        const s = settleSel.props[p.id];
        html += `<div class="field"><label>${esc(p.label)}</label>
          <div class="settle-grid">
            <button data-sp="${p.id}" data-side="a" class="${s === "a" ? "picked" : ""}">${esc(p.option_a)}</button>
            <button data-sp="${p.id}" data-side="b" class="${s === "b" ? "picked" : ""}">${esc(p.option_b)}</button>
          </div></div>`;
      }
      html += `<div class="field"><label>Tiebreaker actual — total points across all matchups</label><input type="number" min="0" id="tbActual" placeholder="e.g. 1040"></div>
        <div class="error" id="settleErr"></div>
        <button id="settleBtn" class="gold" style="width:100%">Settle Week ${sw.week.week_number}</button>`;
    }
  }

  html += `<h3 style="color:var(--green); margin-top:20px">Open a New Week</h3>
    <p class="note">Locks the current week and opens betting on the next one.</p>
    <div class="field"><label>Week number</label><input type="number" id="nwNum" value="${w ? w.week_number + 1 : 6}" min="1"></div>`;
  for (let i = 0; i < 5; i++) {
    html += `<div class="field"><label>Matchup ${i + 1} — team A (favorite listed first), team B, odds A, odds B</label>
      <input id="nwA${i}" placeholder="Team A" style="margin-bottom:4px"><input id="nwB${i}" placeholder="Team B" style="margin-bottom:4px">
      <div style="display:flex;gap:6px"><input id="nwOA${i}" type="number" placeholder="Odds A (e.g. -150)"><input id="nwOB${i}" type="number" placeholder="Odds B (e.g. +130)"></div></div>`;
  }
  for (let i = 0; i < 6; i++) {
    html += `<div class="field"><label>Prop ${i + 1}</label>
      <input id="npL${i}" placeholder="Prop label" style="margin-bottom:4px">
      <div style="display:flex;gap:6px;margin-bottom:4px"><input id="npA${i}" placeholder="Option A"><input id="npB${i}" placeholder="Option B"></div>
      <div style="display:flex;gap:6px"><input id="npOA${i}" type="number" placeholder="Odds A"><input id="npOB${i}" type="number" placeholder="Odds B"></div></div>`;
  }
  html += `<div class="error" id="nwErr"></div><div class="success" id="nwOk"></div>
    <button id="newWeekBtn" style="width:100%">Open New Week</button></div>`;
  el.innerHTML = html;

  el.querySelectorAll("[data-sm]").forEach((b) => b.addEventListener("click", () => {
    settleSel.matchups[b.dataset.sm] = b.dataset.side; renderCommish();
  }));
  el.querySelectorAll("[data-sp]").forEach((b) => b.addEventListener("click", () => {
    settleSel.props[b.dataset.sp] = b.dataset.side; renderCommish();
  }));
  const settleWeekSel = $("settleWeekSel");
  if (settleWeekSel) settleWeekSel.addEventListener("change", () => {
    settleWeekId = Number(settleWeekSel.value);
    settleSel = { matchups: {}, props: {} };
    settleWeekData = null;
    settleWeekDataLoading = false;
    renderCommish();
  });
  const settleBtn = $("settleBtn");
  if (settleBtn) settleBtn.addEventListener("click", async () => {
    $("settleErr").textContent = "";
    try {
      await api("POST", "/api/admin/settle", {
        passcode: "10502",
        week_id: settleWeekId,
        matchup_winners: Object.fromEntries(Object.entries(settleSel.matchups).map(([k, v]) => [Number(k), v])),
        prop_winners: Object.fromEntries(Object.entries(settleSel.props).map(([k, v]) => [Number(k), v])),
        tiebreaker_actual: $("tbActual").value,
      });
      settleSel = { matchups: {}, props: {} };
      settleWeekId = null;
      settleWeekData = null;
      await refresh();
    } catch (e) { $("settleErr").textContent = e.message; }
  });
  $("newWeekBtn").addEventListener("click", async () => {
    $("nwErr").textContent = ""; $("nwOk").textContent = "";
    try {
      const matchups = [], props = [];
      for (let i = 0; i < 5; i++) matchups.push({ team_a: $("nwA" + i).value, team_b: $("nwB" + i).value, odds_a: $("nwOA" + i).value, odds_b: $("nwOB" + i).value });
      for (let i = 0; i < 6; i++) props.push({ label: $("npL" + i).value, option_a: $("npA" + i).value, option_b: $("npB" + i).value, odds_a: $("npOA" + i).value, odds_b: $("npOB" + i).value });
      await api("POST", "/api/admin/new-week", { passcode: "10502", week_number: Number($("nwNum").value), matchups, props });
      $("nwOk").textContent = "New week is open. Tell the league.";
      await refresh();
    } catch (e) { $("nwErr").textContent = e.message; }
  });
}

// ---------- boot ----------
async function refresh() {
  STATE = await api("GET", "/api/state");
  renderHeader();
  renderBoard();
  renderBetsFeed();
  renderPickem();
  renderProps();
  renderLeaderboard();
  renderCommish();
  maybeShowJoin();
}

// ---------- front-door gate ----------
async function tryUnlock() {
  const code = $("gateInput").value.trim();
  $("gateErr").textContent = "";
  try {
    await api("POST", "/api/gate", { passcode: code });
    sessionStorage.setItem("tgb_gate", "1");
    enterBook();
  } catch (e) {
    $("gateErr").textContent = e.message;
    $("gateInput").value = "";
    $("gateInput").focus();
  }
}

function enterBook() {
  document.body.classList.remove("gated");
  $("gate").style.display = "none";
  refresh().catch((e) => {
    $("board").innerHTML = `<div class="card"><h2>Couldn't reach the book</h2><p class="note">${esc(e.message)}</p></div>`;
  });
}

$("gateBtn").addEventListener("click", tryUnlock);
$("gateInput").addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });

// ---------- boot ----------
if (sessionStorage.getItem("tgb_gate") === "1") {
  enterBook();
} else {
  $("gateInput").focus();
}
