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
    let matchups = [], props = [], bets = [], propBets = [], pickems = [], weeks = [];
    if (week) {
      matchups = (await db.query("SELECT * FROM matchups WHERE week_id = $1 ORDER BY idx", [week.id])).rows;
      props = (await db.query("SELECT * FROM props WHERE week_id = $1 ORDER BY idx", [week.id])).rows;
      bets = (await db.query(
        `SELECT b.*, u.team_name FROM bets b JOIN users u ON u.id = b.user_id
         WHERE b.week_id = $1 ORDER BY b.created_at DESC`, [week.id])).rows;
      propBets = (await db.query(
        `SELECT pb.*, u.team_name FROM prop_bets pb JOIN users u ON u.id = pb.user_id
         WHERE pb.week_id = $1 ORDER BY pb.created_at DESC`, [week.id])).rows;
      pickems = (await db.query(
        `SELECT p.*, u.team_name FROM pickems p JOIN users u ON u.id = p.user_id
         WHERE p.week_id = $1 ORDER BY p.created_at`, [week.id])).rows;
    }
    weeks = (await db.query("SELECT id, week_number, status FROM weeks ORDER BY week_number")).rows;
    res.json({ teams: TEAMS, week, users, matchups, props, bets, propBets, pickems, weeks, startingBankroll: STARTING_BANKROLL });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not load league state." });
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
  // kind: 'game' | 'prop'
  const table = kind === "game" ? "matchups" : "props";
  const betTable = kind === "game" ? "bets" : "prop_bets";
  const idCol = kind === "game" ? "matchup_id" : "prop_id";

  if (!week) throw { status: 400, message: "No open betting week." };
  if (!["a", "b"].includes(side)) throw { status: 400, message: "Pick a side." };
  stake = Number(stake);
  if (!Number.isFinite(stake) || stake <= 0) throw { status: 400, message: "Stake must be a positive number." };
  stake = Math.round(stake * 100) / 100;

  const item = (await db.query(`SELECT * FROM ${table} WHERE id = $1 AND week_id = $2`, [itemId, week.id])).rows[0];
  if (!item) throw { status: 404, message: "That line doesn't exist this week." };
  if (item.winner) throw { status: 400, message: "That market is already settled." };

  const fresh = (await db.query("SELECT bankroll FROM users WHERE id = $1", [user.id])).rows[0];
  const bankroll = Number(fresh.bankroll);
  if (stake > bankroll) throw { status: 400, message: `Stake exceeds your ${bankroll.toFixed(2)} GB bankroll.` };

  const odds = side === "a" ? item.odds_a : item.odds_b;
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
    const week = await currentWeek();
    if (!week) return res.status(400).json({ error: "No open week to settle." });

    const matchupWinners = req.body.matchup_winners || {}; // { matchupId: 'a'|'b' }
    const propWinners = req.body.prop_winners || {};       // { propId: 'a'|'b' }
    const tiebreakerActual = req.body.tiebreaker_actual;   // total points across matchups

    const matchups = (await db.query("SELECT * FROM matchups WHERE week_id = $1", [week.id])).rows;
    for (const m of matchups) {
      const w = matchupWinners[m.id];
      if (!w || !["a", "b"].includes(w)) return res.status(400).json({ error: `Winner missing for ${m.team_a} vs ${m.team_b}.` });
    }
    const props = (await db.query("SELECT * FROM props WHERE week_id = $1", [week.id])).rows;
    for (const p of props) {
      const w = propWinners[p.id];
      if (!w || !["a", "b"].includes(w)) return res.status(400).json({ error: `Winner missing for prop: ${p.label}.` });
    }

    // Settle game bets + prop bets.
    for (const [table, idCol, winners] of [["bets", "matchup_id", matchupWinners], ["prop_bets", "prop_id", propWinners]]) {
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
    for (const m of matchups) await db.query("UPDATE matchups SET winner = $1 WHERE id = $2", [matchupWinners[m.id], m.id]);
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
        ["week_id", "idx", "team_a", "team_b", "odds_a", "odds_b"],
        [weekId, i, m.team_a.trim(), m.team_b.trim(), Number(m.odds_a), Number(m.odds_b)]
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
