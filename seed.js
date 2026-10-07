// seed.js — seeds Week 5 (the current week) on first boot if the DB is empty.
// The commish creates future weeks from the Admin tab; no code changes needed.

const db = require("./db");

const WEEK_5_MATCHUPS = [
  { team_a: "Ostys Soldiers", display_a: "Osty's Soldiers", team_b: "The Pezzler", display_b: "The Pezzler", odds_a: -150, odds_b: 130 },
  { team_a: "Jaron's Scary Team", display_a: "Jaron's Scary Team", team_b: "OPP", display_b: "OPP", odds_a: -150, odds_b: 130 },
  { team_a: "Eiki's Team", display_a: "Eiki's Team", team_b: "Osama Ben Laden", display_b: "Osama Ben Laden", odds_a: -185, odds_b: 160 },
  { team_a: "J$", display_a: "J$", team_b: "E's Team", display_b: "E's Team", odds_a: -110, odds_b: -110 },
  { team_a: "Alex's Astounding Team", display_a: "Alex's Astounding Team", team_b: "Evan's Excellent Team", display_b: "Evan's Excellent Team", odds_a: -220, odds_b: 180 },
];

const WEEK_5_PROPS = [
  { label: "Highest team score of the week", option_a: "Over 140.5", option_b: "Under 140.5", odds_a: -110, odds_b: -110 },
  { label: "Biggest blowout margin", option_a: "Over 40.5 pts", option_b: "Under 40.5 pts", odds_a: -110, odds_b: -110 },
  { label: "Will anyone crack 150 points?", option_a: "Yes", option_b: "No", odds_a: 200, odds_b: -250 },
  { label: "Lowest team total of the week", option_a: "Under 75.5", option_b: "Over 75.5", odds_a: -110, odds_b: -110 },
  { label: "Total points across all 5 matchups", option_a: "Over 1050.5", option_b: "Under 1050.5", odds_a: -110, odds_b: -110 },
  { label: "Most points by a single player", option_a: "Over 32.5", option_b: "Under 32.5", odds_a: -110, odds_b: -110 },
];

async function seedIfEmpty() {
  const { rows } = await db.query("SELECT COUNT(*) AS c FROM weeks");
  if (Number(rows[0].c) > 0) return; // already seeded

  const weekId = await db.insertReturningId("weeks", ["week_number", "status"], [5, "open"]);

  for (let i = 0; i < WEEK_5_MATCHUPS.length; i++) {
    const m = WEEK_5_MATCHUPS[i];
    await db.insertReturningId(
      "matchups",
      ["week_id", "idx", "team_a", "team_b", "odds_a", "odds_b"],
      [weekId, i, m.display_a, m.display_b, m.odds_a, m.odds_b]
    );
  }
  for (let i = 0; i < WEEK_5_PROPS.length; i++) {
    const p = WEEK_5_PROPS[i];
    await db.insertReturningId(
      "props",
      ["week_id", "idx", "label", "option_a", "option_b", "odds_a", "odds_b"],
      [weekId, i, p.label, p.option_a, p.option_b, p.odds_a, p.odds_b]
    );
  }
  console.log("Seeded Week 5 matchups + props.");
}

module.exports = { seedIfEmpty, WEEK_5_MATCHUPS, WEEK_5_PROPS };
