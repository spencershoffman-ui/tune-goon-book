# Tune and Goon Book 📖

A fake-money sportsbook for the **Tune and Goon** fantasy football league (10 teams, 0.5 PPR).
Everyone gets **1,000 Goon Bucks (fake)** and bets them on the week's fantasy matchups, a prop
sheet, and a pick'em contest. All bets, picks, and bankrolls are **shared** — everyone sees
everything. No real money anywhere. The glory, however, is very real.

## What's inside

- **Betting board** — 5 weekly fantasy matchups with moneyline odds, bet slip, public bet feed
- **Prop sheet** — 6 fun weekly props, bet Goon Bucks on either side
- **Pick'em** — pick all 5 winners + a tiebreaker (total points across matchups), auto-scored
- **Leaderboard** — live Goon Bucks bankrolls for the whole league
- **Commish panel** (passcode-gated) — settle the week (pays out bets, scores pick'ems) and open the next week's lines
- **Toilet Bowl** — stub tab, coming later in the season

## Run it locally

You need [Node.js](https://nodejs.org) 22 or newer (the local database uses Node's built-in SQLite).

```bash
cd goon-bucks-app
npm install
npm start
```

Open http://localhost:3000. It uses a local SQLite file (`data/goonbucks.db`), so no
database setup needed — Week 5 lines are seeded automatically on first boot.

## Deploy it on Railway (free tier)

Railway gives you a real server + PostgreSQL database so the whole league shares one book.

1. **Put the code on GitHub.** Create a new repo at github.com/new, then:
   ```bash
   cd goon-bucks-app
   git init
   git add .
   git commit -m "Tune and Goon Book"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
   git push -u origin main
   ```
2. **Create a Railway project.** Go to railway.app → New Project → Deploy from GitHub → pick your repo.
3. **Add PostgreSQL.** In the project, click **+ New → Database → PostgreSQL**. Railway automatically
   wires it up as `DATABASE_URL` — no env vars to copy by hand.
4. **(Optional) Change the passcode.** In the service's Variables tab, add
   `ADMIN_PASSCODE` with your own code. Default is `10502`. This one code guards
   both the front-door gate (every visitor must enter it) and the commish panel.
5. **Deploy.** Railway builds and starts the app (`npm start`). Open the public URL it gives you
   (Settings → Networking → Generate Domain) and send it to the league.

That's it. Bankrolls, bets, and picks all live in the shared Postgres database.

## Commish cheat sheet

- **Join:** everyone opens the link, claims their team, gets 1,000 GB.
- **During the week:** league bets on games + props, locks in pick'ems.
- **After games:** Commish tab → enter passcode → mark each matchup/prop winner, enter the
  actual total points (tiebreaker) → **Settle Week**. Payouts and pick'em scores apply to everyone.
- **Next week:** Commish tab → fill in the 5 new matchups + odds and 6 props → **Open New Week**.

## Tech notes

- Node + Express serves the frontend and a JSON API. Frontend is vanilla JS, no build step.
- Database: PostgreSQL when `DATABASE_URL` is set, otherwise local SQLite file. Schema is
  created automatically on boot; Week 5 is seeded if the database is empty.
- Payout math: American odds. Favorite at −150: a 15 GB bet profits 10 GB. Dog at +130:
  a 10 GB bet profits 13 GB. Rounded to cents.
