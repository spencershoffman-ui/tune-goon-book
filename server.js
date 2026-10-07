// server.js — Tune and Goon Book backend.
// Express serves the frontend from /public and exposes a JSON API.
// Goon Bucks are fake money. The glory is real.

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const db = require("./db");
const { seedIfEmpty } = require("./seed");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || "10502"; // commish-only actions
const PICKEM_PRIZE = 200; // Goon Bucks awarded to the best pick'em entry each settled week

const TEAMS = [
  "The Pezzler",
  "Eiki's Team",
  "E's Team",
  "OPP",
  "Alex's Astounding Team",
  "Evan's Excellent Team",
  "Jaron's Scary Team",
  "J$",
  "Osty's Soldiers",
  "Osama Ben Laden",
];
const STARTING_BANKROLL = 1000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- helpers ----------

// American odds -> profit on a winning stake. Returns rounded dollars.
function profitForOdds(stake, odds) {
  let profit;
  if (odds > 0) profit = stake * (odds / 100);
  else if (odds < 0) profit = stake * (100 / Math.abs(odds));
  else throw new Error("Odds of 0 are invalid");
  return Math.round(profit * 100) / 100;
}

function checkAdmin(req, res) {
  if (req.body.passcode !== ADMIN_PASSCODE) {
    res.status(403).json({ error: "Wrong passcode. Commish only." });
    return false;
  }
  return true;
}

// Authenticate a mutating request: user id + per-user token (stored in their browser).
async function authUser(req, res) {
  const userId = Number(req.body.user_id || req.query.user_id);
  const token = req.headers["x-user-token"] || req.body.token;
  if (!userId || !token) {
    res.status(401).json({ error: "Not signed in." });
    return null;
  }
  const { rows } = await db.query("SELECT * FROM users WHERE id = $1", [userId]);
  const user = rows[0];
  if (!user || user.token !== token) {
    res.status(401).json({ error: "Bad session. Rejoin from your original sign-in." });
    return null;
  }
  return user;
}

async function currentWeek() {
  const { rows } = await db.query("SELECT * FROM weeks WHERE status = 'open' ORDER BY week_number DESC LIMIT 1");
  return rows[0] || null;
}

// ---------- front-door gate ----------
// Keeps random visitors out. Uses the same passcode as commish actions.
app.post("/api/gate", (req, res) => {
  if (req.body.passcode === ADMIN_PASSCODE) return res.json({ ok: true });
  res.status(403).json({ error: "Wrong passcode." });
});

// ---------- public state ----------

// One call gives the frontend everything it needs to render.
app.get("/api/state", async (req, res) => {
  try {
    const week = await currentWeek();
    const users = (await db.query("SELECT id, team_name, bankroll, created_at FROM users ORDER BY bankroll DESC")).rows;
    let matchups = [], props = [], bets = [], propBets = [], spreadBets = [], futureBets = [], pickems = [], weeks = [];
    if (week) {
      matchups = (await db.query("SELECT * FROM matchups WHERE week_id = $1 ORDER BY idx", [week.id])).rows;
      props = (await db.query("SELECT * FROM props WHERE week_id = $1 ORDER BY idx", [week.id])).rows;
      bets = (await db.query(
        `SELECT b.*, u.team_name FROM bets b JOIN users u ON u.id = b.user_id
         WHERE b.week_id = $1 ORDER BY b.created_at DESC`, [week.id])).rows;
      propBets = (await db.query(
        `SELECT pb.*, u.team_name FROM prop_bets pb JOIN users u ON u.id = pb.user_id
         WHERE pb.week_id = $1 ORDER BY pb.created_at DESC`, [week.id])).rows;
      spreadBets = (await db.query(
        `SELECT sb.*, u.team_name FROM spread_bets sb JOIN users u ON u.id = sb.user_id
         WHERE sb.week_id = $1 ORDER BY sb.created_at DESC`, [week.id])).rows;
      pickems = (await db.query(
        `SELECT p.*, u.team_name FROM pickems p JOIN users u ON u.id = p.user_id
         WHERE p.week_id = $1 ORDER BY p.created_at`, [week.id])).rows;
    }
    const futures = (await db.query(
      `SELECT * FROM futures
       ORDER BY CASE category WHEN 'champion' THEN 0 WHEN 'wins' THEN 1 ELSE 2 END, team_name`)).rows;
    futureBets = (await db.query(
      `SELECT fb.*, u.team_name FROM future_bets fb JOIN users u ON u.id = fb.user_id
       ORDER BY fb.created_at DESC`)).rows;
    weeks = (await db.query("SELECT id, week_number, status FROM weeks ORDER BY week_number")).rows;
    res.json({ teams: TEAMS, week, users, matchups, props, bets, propBets, spreadBets, pickems, futures, futureBets, weeks, startingBankroll: STARTING_BANKROLL });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not load league state." });
  }
});

// Full data for one week (used by the commish tab to settle older weeks).
// Public — bets, picks and lines are visible to the whole league anyway.
app.get("/api/week/:id", async (req, res) => {
  try {
    const weekId = Number(req.params.id);
    const week = (await db.query("SELECT * FROM weeks WHERE id = $1", [weekId])).rows[0];
    if (!week) return res.status(404).json({ error: "Week not found." });
    const matchups = (await db.query("SELECT * FROM matchups WHERE week_id = $1 ORDER BY idx", [weekId])).rows;
    const props = (await db.query("SELECT * FROM props WHERE week_id = $1 ORDER BY idx", [weekId])).rows;
    res.json({ week, matchups, props });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not load week." });
  }
});

// ---------- join ----------

// Claim one of the 10 team names (first come, first served). One bettor per team.
app.post("/api/join", async (req, res) => {
  try {
    const teamName = (req.body.team_name || "").trim();
    if (!TEAMS.includes(teamName)) return res.status(400).json({ error: "Pick a real league team." });
    const existing = (await db.query("SELECT id FROM users WHERE team_name = $1", [teamName])).rows[0];
    if (existing) return res.status(409).json({ error: `${teamName} is already claimed.` });
    const token = crypto.randomBytes(16).toString("hex");
    const id = await db.insertReturningId("users", ["team_name", "token", "bankroll"], [teamName, token, STARTING_BANKROLL]);
    res.json({ id, team_name: teamName, bankroll: STARTING_BANKROLL, token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not join." });
  }
});

// ---------- betting ----------

async function placeWager({ user, week, kind, itemId, side, stake }) {
  // kind: 'game' | 'spread' | 'prop'
  const table = kind === "prop" ? "props" : "matchups";
  const betTable = kind === "game" ? "bets" : kind === "spread" ? "spread_bets" : "prop_bets";
  const idCol = kind === "game" ? "matchup_id" : kind === "spread" ? "matchup_id" : "prop_id";

  if (!week) throw { status: 400, message: "No open betting week." };
  if (!["a", "b"].includes(side)) throw { status: 400, message: "Pick a side." };
  stake = Number(stake);
  if (!Number.isFinite(stake) || stake <= 0) throw { status: 400, message: "Stake must be a positive number." };
  stake = Math.round(stake * 100) / 100;

  const item = (await db.query(`SELECT * FROM ${table} WHERE id = $1 AND week_id = $2`, [itemId, week.id])).rows[0];
  if (!item) throw { status: 404, message: "That line doesn't exist this week." };
  if (item.winner) throw { status: 400, message: "That market is already settled." };

  let odds;
  if (kind === "spread") {
    if (item.spread_line === null || item.spread_line === undefined) {
      throw { status: 400, message: "No spread posted for that matchup yet." };
    }
    odds = side === "a" ? item.spread_odds_a : item.spread_odds_b;
  } else {
    odds = side === "a" ? item.odds_a : item.odds_b;
  }

  const fresh = (await db.query("SELECT bankroll FROM users WHERE id = $1", [user.id])).rows[0];
  const bankroll = Number(fresh.bankroll);
  if (stake > bankroll) throw { status: 400, message: `Stake exceeds your ${bankroll.toFixed(2)} GB bankroll.` };

  await db.query("UPDATE users SET bankroll = bankroll - $1 WHERE id = $2", [stake, user.id]);
  const betId = await db.insertReturningId(
    betTable,
    ["user_id", "week_id", idCol, "side", "odds", "stake", "status"],
    [user.id, week.id, itemId, side, odds, stake, "open"]
  );
  const updated = (await db.query("SELECT bankroll FROM users WHERE id = $1", [user.id])).rows[0];
  return { betId, bankroll: Number(updated.bankroll) };
}

app.post("/api/bets", async (req, res) => {
  try {
    const user = await authUser(req, res);
    if (!user) return;
    const week = await currentWeek();
    const result = await placeWager({ user, week, kind: "game", itemId: Number(req.body.matchup_id), side: req.body.side, stake: req.body.stake });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Could not place bet." });
  }
});

app.post("/api/prop-bets", async (req, res) => {
  try {
    const user = await authUser(req, res);
    if (!user) return;
    const week = await currentWeek();
    const result = await placeWager({ user, week, kind: "prop", itemId: Number(req.body.prop_id), side: req.body.side, stake: req.body.stake });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Could not place prop bet." });
  }
});

app.post("/api/spread-bets", async (req, res) => {
  try {
    const user = await authUser(req, res);
    if (!user) return;
    const week = await currentWeek();
    const result = await placeWager({ user, week, kind: "spread", itemId: Number(req.body.matchup_id), side: req.body.side, stake: req.body.stake });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Could not place spread bet." });
  }
});

// ---------- futures betting ----------

app.post("/api/future-bets", async (req, res) => {
  try {
    const user = await authUser(req, res);
    if (!user) return;
    const futureId = Number(req.body.future_id);
    const side = req.body.side;
    let stake = Number(req.body.stake);
    if (!["a", "b"].includes(side)) return res.status(400).json({ error: "Pick a side." });
    if (!Number.isFinite(stake) || stake <= 0) return res.status(400).json({ error: "Stake must be a positive number." });
    stake = Math.round(stake * 100) / 100;

    const future = (await db.query("SELECT * FROM futures WHERE id = $1", [futureId])).rows[0];
    if (!future) return res.status(404).json({ error: "That future doesn't exist." });
    if (future.status !== "open") return res.status(400).json({ error: "That future is already settled." });
    if (side === "b" && (future.option_b === null || future.option_b === undefined)) {
      return res.status(400).json({ error: "That future only takes one side." });
    }
    const odds = side === "a" ? future.odds_a : future.odds_b;

    const fresh = (await db.query("SELECT bankroll FROM users WHERE id = $1", [user.id])).rows[0];
    const bankroll = Number(fresh.bankroll);
    if (stake > bankroll) return res.status(400).json({ error: `Stake exceeds your ${bankroll.toFixed(2)} GB bankroll.` });

    await db.query("UPDATE users SET bankroll = bankroll - $1 WHERE id = $2", [stake, user.id]);
    const betId = await db.insertReturningId(
      "future_bets",
      ["user_id", "future_id", "side", "odds", "stake", "status"],
      [user.id, futureId, side, odds, stake, "open"]
    );
    const updated = (await db.query("SELECT bankroll FROM users WHERE id = $1", [user.id])).rows[0];
    res.json({ ok: true, betId, bankroll: Number(updated.bankroll) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not place future bet." });
  }
});

// ---------- pick'em ----------

// Submit (or update) this week's 5 picks + tiebreaker. One entry per player per week.
app.post("/api/pickem", async (req, res) => {
  try {
    const user = await authUser(req, res);
    if (!user) return;
    const week = await currentWeek();
    if (!week) return res.status(400).json({ error: "No open week." });

    const matchups = (await db.query("SELECT id FROM matchups WHERE week_id = $1 ORDER BY idx", [week.id])).rows;
    const picks = req.body.picks;
    const tiebreaker = Number(req.body.tiebreaker);
    if (!Array.isArray(picks) || picks.length !== matchups.length) {
      return res.status(400).json({ error: `Pick all ${matchups.length} matchups.` });
    }
    for (const p of picks) {
      if (!p || !["a", "b"].includes(p.side) || !matchups.some((m) => m.id === Number(p.matchup_id))) {
        return res.status(400).json({ error: "Invalid picks." });
      }
    }
    if (!Number.isFinite(tiebreaker) || tiebreaker < 0) {
      return res.status(400).json({ error: "Tiebreaker must be a non-negative number." });
    }

    const existing = (await db.query("SELECT id FROM pickems WHERE user_id = $1 AND week_id = $2", [user.id, week.id])).rows[0];
    const picksJson = JSON.stringify(picks.map((p) => ({ matchup_id: Number(p.matchup_id), side: p.side })));
    if (existing) {
      await db.query("UPDATE pickems SET picks = $1, tiebreaker = $2 WHERE id = $3", [picksJson, tiebreaker, existing.id]);
    } else {
      await db.insertReturningId("pickems", ["user_id", "week_id", "picks", "tiebreaker"], [user.id, week.id, picksJson, tiebreaker]);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not save picks." });
  }
});

// ---------- commish: settle the week ----------

app.post("/api/admin/settle", async (req, res) => {
  try {
    if (!checkAdmin(req, res)) return;
    // Settle a specific week when week_id is given (lets the commish settle an
    // older week after a newer one is already open); otherwise the open week.
    const weekId = req.body.week_id ? Number(req.body.week_id) : null;
    let week;
    if (weekId) {
      week = (await db.query("SELECT * FROM weeks WHERE id = $1", [weekId])).rows[0];
      if (!week) return res.status(400).json({ error: "Week not found." });
      if (week.status === "settled") return res.status(400).json({ error: `Week ${week.week_number} is already settled.` });
    } else {
      week = await currentWeek();
      if (!week) return res.status(400).json({ error: "No open week to settle." });
    }

    const matchupWinners = req.body.matchup_winners || {}; // { matchupId: 'a'|'b' }
    const propWinners = req.body.prop_winners || {};       // { propId: 'a'|'b' }
    const spreadWinners = req.body.spread_winners || {};   // { matchupId: 'a'|'b' }
    const tiebreakerActual = req.body.tiebreaker_actual;   // total points across matchups

    const matchups = (await db.query("SELECT * FROM matchups WHERE week_id = $1", [week.id])).rows;
    for (const m of matchups) {
      const w = matchupWinners[m.id];
      if (!w || !["a", "b"].includes(w)) return res.status(400).json({ error: `Winner missing for ${m.team_a} vs ${m.team_b}.` });
      if (m.spread_line !== null && m.spread_line !== undefined) {
        const sw = spreadWinners[m.id];
        if (!sw || !["a", "b"].includes(sw)) return res.status(400).json({ error: `Spread winner missing for ${m.team_a} vs ${m.team_b}.` });
      }
    }
    const props = (await db.query("SELECT * FROM props WHERE week_id = $1", [week.id])).rows;
    for (const p of props) {
      const w = propWinners[p.id];
      if (!w || !["a", "b"].includes(w)) return res.status(400).json({ error: `Winner missing for prop: ${p.label}.` });
    }

    // Settle game bets + spread bets + prop bets.
    for (const [table, idCol, winners] of [["bets", "matchup_id", matchupWinners], ["spread_bets", "matchup_id", spreadWinners], ["prop_bets", "prop_id", propWinners]]) {
      const open = (await db.query(`SELECT * FROM ${table} WHERE week_id = $1 AND status = 'open'`, [week.id])).rows;
      for (const b of open) {
        const won = b.side === winners[b[idCol]];
        if (won) {
          const profit = profitForOdds(Number(b.stake), Number(b.odds));
          const payout = Math.round((Number(b.stake) + profit) * 100) / 100;
          await db.query(`UPDATE ${table} SET status = 'won', payout = $1 WHERE id = $2`, [payout, b.id]);
          await db.query("UPDATE users SET bankroll = bankroll + $1 WHERE id = $2", [payout, b.user_id]);
        } else {
          await db.query(`UPDATE ${table} SET status = 'lost', payout = 0 WHERE id = $1`, [b.id]);
        }
      }
    }

    // Record winners on matchups/props.
    for (const m of matchups) {
      await db.query("UPDATE matchups SET winner = $1, spread_winner = $2 WHERE id = $3",
        [matchupWinners[m.id], spreadWinners[m.id] || null, m.id]);
    }
    for (const p of props) await db.query("UPDATE props SET winner = $1 WHERE id = $2", [propWinners[p.id], p.id]);

    // Auto-score pick'ems.
    if (tiebreakerActual !== undefined && tiebreakerActual !== null && tiebreakerActual !== "") {
      const actual = Number(tiebreakerActual);
      if (!Number.isFinite(actual) || actual < 0) return res.status(400).json({ error: "Tiebreaker actual must be a non-negative number." });
      const entries = (await db.query("SELECT * FROM pickems WHERE week_id = $1", [week.id])).rows;
      for (const e of entries) {
        const picks = JSON.parse(e.picks);
        let correct = 0;
        for (const p of picks) {
          if (matchupWinners[p.matchup_id] === p.side) correct++;
        }
        const diff = Math.round(Math.abs(Number(e.tiebreaker) - actual) * 100) / 100;
        await db.query("UPDATE pickems SET correct = $1, tiebreak_diff = $2 WHERE id = $3", [correct, diff, e.id]);
      }
      await db.query("UPDATE weeks SET tiebreaker_actual = $1 WHERE id = $2", [actual, week.id]);

      // Pick'em prize: 200 Goon Bucks to the best entry — most correct picks,
      // ties broken by closest tiebreaker. A perfect tie at the top splits it.
      const scored = (await db.query("SELECT * FROM pickems WHERE week_id = $1", [week.id])).rows;
      if (scored.length) {
        const maxCorrect = Math.max(...scored.map((e) => Number(e.correct)));
        let leaders = scored.filter((e) => Number(e.correct) === maxCorrect);
        const minDiff = Math.min(...leaders.map((e) => Number(e.tiebreak_diff)));
        leaders = leaders.filter((e) => Number(e.tiebreak_diff) === minDiff);
        const prize = Math.round((PICKEM_PRIZE / leaders.length) * 100) / 100;
        for (const l of leaders) {
          await db.query("UPDATE users SET bankroll = bankroll + $1 WHERE id = $2", [prize, l.user_id]);
        }
      }
    }

    await db.query("UPDATE weeks SET status = 'settled' WHERE id = $1", [week.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not settle the week." });
  }
});

// ---------- commish: open a new week ----------

app.post("/api/admin/new-week", async (req, res) => {
  try {
    if (!checkAdmin(req, res)) return;
    const weekNumber = Number(req.body.week_number);
    const matchups = req.body.matchups || [];
    const props = req.body.props || [];

    if (!Number.isInteger(weekNumber) || weekNumber < 1) return res.status(400).json({ error: "Week number must be a positive integer." });
    if (matchups.length !== 5) return res.status(400).json({ error: "Enter exactly 5 matchups." });
    if (props.length !== 6) return res.status(400).json({ error: "Enter exactly 6 props." });
    for (const m of matchups) {
      if (!m.team_a || !m.team_b || !Number.isInteger(Number(m.odds_a)) || !Number.isInteger(Number(m.odds_b)) || Number(m.odds_a) === 0 || Number(m.odds_b) === 0) {
        return res.status(400).json({ error: "Each matchup needs both teams and non-zero integer odds." });
      }
      // Spread is optional; when given, the line is from team A's perspective (e.g. -3.5).
      if (m.spread_line !== undefined && m.spread_line !== null && m.spread_line !== "") {
        if (!Number.isFinite(Number(m.spread_line))) return res.status(400).json({ error: "Spread lines must be numbers." });
        m.spread_line = Number(m.spread_line);
      } else {
        m.spread_line = null;
      }
      m.spread_odds_a = m.spread_odds_a !== undefined && m.spread_odds_a !== "" ? Number(m.spread_odds_a) : -110;
      m.spread_odds_b = m.spread_odds_b !== undefined && m.spread_odds_b !== "" ? Number(m.spread_odds_b) : -110;
      if (!Number.isInteger(m.spread_odds_a) || !Number.isInteger(m.spread_odds_b) || m.spread_odds_a === 0 || m.spread_odds_b === 0) {
        return res.status(400).json({ error: "Spread odds must be non-zero integers." });
      }
    }
    for (const p of props) {
      if (!p.label || !p.option_a || !p.option_b || !Number.isInteger(Number(p.odds_a)) || !Number.isInteger(Number(p.odds_b)) || Number(p.odds_a) === 0 || Number(p.odds_b) === 0) {
        return res.status(400).json({ error: "Each prop needs a label, both options, and non-zero integer odds." });
      }
    }

    const dupe = (await db.query("SELECT id FROM weeks WHERE week_number = $1", [weekNumber])).rows[0];
    if (dupe) return res.status(409).json({ error: `Week ${weekNumber} already exists.` });

    // Lock any currently open week (bets are already settled or void by commish decision).
    await db.query("UPDATE weeks SET status = 'locked' WHERE status = 'open'");

    const weekId = await db.insertReturningId("weeks", ["week_number", "status"], [weekNumber, "open"]);
    for (let i = 0; i < matchups.length; i++) {
      const m = matchups[i];
      await db.insertReturningId(
        "matchups",
        ["week_id", "idx", "team_a", "team_b", "odds_a", "odds_b", "spread_line", "spread_odds_a", "spread_odds_b"],
        [weekId, i, m.team_a.trim(), m.team_b.trim(), Number(m.odds_a), Number(m.odds_b), m.spread_line, m.spread_odds_a, m.spread_odds_b]
      );
    }
    for (let i = 0; i < props.length; i++) {
      const p = props[i];
      await db.insertReturningId(
        "props",
        ["week_id", "idx", "label", "option_a", "option_b", "odds_a", "odds_b"],
        [weekId, i, p.label.trim(), p.option_a.trim(), p.option_b.trim(), Number(p.odds_a), Number(p.odds_b)]
      );
    }
    res.json({ ok: true, week_number: weekNumber });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not open the new week." });
  }
});

// ---------- commish: futures ----------

const FUTURE_CATEGORIES = ["wins", "champion", "playoffs"];

// Create a season future (win total, championship, playoff yes/no).
app.post("/api/admin/futures", async (req, res) => {
  try {
    if (!checkAdmin(req, res)) return;
    const category = req.body.category;
    const teamName = (req.body.team_name || "").trim();
    if (!FUTURE_CATEGORIES.includes(category)) return res.status(400).json({ error: "Bad future category." });
    if (!TEAMS.includes(teamName)) return res.status(400).json({ error: "Pick a real league team." });

    let { line, option_a, option_b, odds_a, odds_b } = req.body;
    if (category === "wins") {
      line = Number(line);
      if (!Number.isFinite(line)) return res.status(400).json({ error: "Win total needs a line (e.g. 8.5)." });
      option_a = option_a || "Over";
      option_b = option_b || "Under";
    } else if (category === "playoffs") {
      line = null;
      option_a = option_a || "Yes";
      option_b = option_b || "No";
    } else {
      line = null;
      option_a = option_a || teamName;
      option_b = null;
      odds_b = null;
    }
    odds_a = Number(odds_a);
    odds_b = odds_b === null || odds_b === undefined || odds_b === "" ? null : Number(odds_b);
    if (!Number.isInteger(odds_a) || odds_a === 0) return res.status(400).json({ error: "Odds A must be a non-zero integer." });
    if (odds_b !== null && (!Number.isInteger(odds_b) || odds_b === 0)) {
      return res.status(400).json({ error: "Odds B must be a non-zero integer." });
    }

    const labels = {
      wins: `${teamName} — season wins`,
      champion: `${teamName} — wins the league`,
      playoffs: `${teamName} — makes the playoffs`,
    };
    const id = await db.insertReturningId(
      "futures",
      ["category", "team_name", "label", "line", "option_a", "option_b", "odds_a", "odds_b"],
      [category, teamName, labels[category], line, option_a, option_b, odds_a, odds_b]
    );
    res.json({ ok: true, id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not create future." });
  }
});

async function settleFutureBets(futureId, winner) {
  // winner: 'a' | 'b'. Pays winning future_bets, zeroes losers.
  const open = (await db.query("SELECT * FROM future_bets WHERE future_id = $1 AND status = 'open'", [futureId])).rows;
  for (const b of open) {
    if (b.side === winner) {
      const profit = profitForOdds(Number(b.stake), Number(b.odds));
      const payout = Math.round((Number(b.stake) + profit) * 100) / 100;
      await db.query("UPDATE future_bets SET status = 'won', payout = $1 WHERE id = $2", [payout, b.id]);
      await db.query("UPDATE users SET bankroll = bankroll + $1 WHERE id = $2", [payout, b.user_id]);
    } else {
      await db.query("UPDATE future_bets SET status = 'lost', payout = 0 WHERE id = $1", [b.id]);
    }
  }
  await db.query("UPDATE futures SET status = 'settled', winner = $1 WHERE id = $2", [winner, futureId]);
}

// Settle a single binary future (win total or playoff yes/no).
app.post("/api/admin/settle-future", async (req, res) => {
  try {
    if (!checkAdmin(req, res)) return;
    const future = (await db.query("SELECT * FROM futures WHERE id = $1", [Number(req.body.future_id)])).rows[0];
    if (!future) return res.status(404).json({ error: "Future not found." });
    if (future.status !== "open") return res.status(400).json({ error: "That future is already settled." });
    if (future.category === "champion") {
      return res.status(400).json({ error: "Settle the championship from the champion picker — it settles all teams at once." });
    }
    const winner = req.body.winner;
    if (!["a", "b"].includes(winner)) return res.status(400).json({ error: "Pick a winning side." });
    await settleFutureBets(future.id, winner);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not settle future." });
  }
});

// Settle the championship: name the winning team, every champion future settles.
app.post("/api/admin/settle-champion", async (req, res) => {
  try {
    if (!checkAdmin(req, res)) return;
    const teamName = (req.body.team_name || "").trim();
    if (!TEAMS.includes(teamName)) return res.status(400).json({ error: "Pick a real league team." });
    const rows = (await db.query("SELECT * FROM futures WHERE category = 'champion' AND status = 'open'")).rows;
    if (!rows.length) return res.status(400).json({ error: "No open championship futures." });
    for (const f of rows) {
      // Champion futures are single-side: the team's row wins only if they took the title.
      await settleFutureBets(f.id, f.team_name === teamName ? "a" : "b");
    }
    res.json({ ok: true, settled: rows.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not settle championship." });
  }
});

// ---------- boot ----------

async function boot() {
  await db.init();
  await seedIfEmpty();
  app.listen(PORT, () => console.log(`Tune and Goon Book live on port ${PORT}`));
}

boot().catch((e) => {
  console.error("Failed to boot:", e);
  process.exit(1);
});
