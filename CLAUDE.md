# Drug Safety Simulator

**This game is about PHARMACOVIGILANCE (drug safety), not workplace/EHS safety.**
"Safety" means adverse event case processing, ICSRs, MedDRA coding, narratives, QC, follow-up queries,
expedited reporting deadlines (7/15-day), aggregate reports (PSUR/PBRER/DSUR), signal detection, SOPs,
audits/inspections and the safety database. Never add PPE, spills, forklifts, fire drills or similar EHS content.

## What it is
A single-file, top-down arcade office game. You play Case-Closed Casey, a Senior Safety Specialist, walking
around the office with Pokemon-style grid movement, working adverse event cases at your desk before their
deadlines, drinking coffee (kitchen + open-plan machine), grabbing snacks from the vending machine (Energy), taking
bio breaks in the WC (Sanity; Pat can't scold you in there), reading silly corporate emails on the TV, chatting with
colleagues, playing mini-games with them (Code It!, Abstract Blitz, Serious or Not?, Spot the Error, table tennis) and
getting scolded by the Manager and Director. Players can clock out on purpose (O / 🕔), which still posts their score.
On phones, alerts sit at the top and can be minimised; meeting calls start minimised with an arrow to the meeting room.
Pacing goal: relaxed, not stressful. An average player should last ~15 minutes; an idle player a few minutes.
Audience: PV colleagues. Humor must be affectionate inside jokes, never mean about real people or the company.

## Hard rules
- Everything lives in `index.html`: vanilla JS + canvas, no frameworks, no build step, no external files,
  no downloaded images/fonts/audio. Everything is drawn and synthesized in code.
- Fictional content only: no real patient data, product names, colleague names, logos or confidential info.
  The company name may appear in text only.
- All tuning numbers go in `CONFIG` (top of the script). All dialogue, events, jokes and death screens go in `CONTENT`.
- Wrap every `localStorage` access in try/catch (use the `Store` helper).
- The only network call is the optional office leaderboard (`CONFIG.leaderboard`, Supabase REST). The game must keep
  working without it: offline or blocked, `Board` falls back to this computer's scores. Never add other network calls.

## Office leaderboard (Supabase)
- Project `drug-safety-sim` (ref `rotqmeawxjvscalauier`, eu-central-1) in the owner's Supabase org, table `public.leaderboard`:
  `player_id` (random UUID per browser), `name` (1-16 chars), `score`, `days`, `cases`, `created_at`.
- RLS: anyone may SELECT and INSERT; nobody may UPDATE or DELETE with the public key. A check constraint rejects scores
  that don't match the game's formula (`score <= floor(days*100) + cases*25 + 1`). Keep it in sync if `CONFIG.score` changes.
- The publishable key in `CONFIG.leaderboard.key` is public by design. Never put a secret/service key in the page.
- Players enter a name before every shift (`UI.showNameEntry`); each finished game is one row; the page shows each
  player's best. Moderate or reset scores from the Supabase dashboard (Table editor -> leaderboard).
- Tests mock the leaderboard (`page.route`) and never post real scores; one read-only check hits the live API.

## Sharing
Hosted with GitHub Pages from `main` (repo root, `index.html`): https://martindjabrailov.github.io/safety-specialist-sim/
The HTML file can also be sent directly; it then uses the same office leaderboard when online.

## Code map (sections inside the `<script>` in index.html)
`CONFIG` · `CONTENT` · helpers · map (`buildMap`, 40x26 tiles) · pathfinding (BFS) · entities + grid movement ·
state · game flow · stats/effects · player control · cases · NPCs/scoldings/director · events/meetings ·
audio (`Sound`, `sfx`, `Music`) · pixel font · rendering · people · particles/bubbles · main render ·
mini-games (`QuizGame`, `PongGame`) · UI · input · main loop. Quiz content lives in `CONTENT.minigames`.
`window.DSS` exposes state and a headless `simulate(policy)` used by the tests.

## Run
Double-click `index.html` (Chrome or Edge). No server needed.

## Test
```
cd tests
npm install          # installs Playwright (uses your installed Chrome; falls back to Playwright's Chromium)
node smoke.js        # real input end-to-end: walk, coffee, talk, work a case, late case -> scolding, director,
                     # events, meeting, mini-games, name entry, leaderboard (mocked + offline fallback + live read-only check),
                     # game over, restart, persistence, phone layout. Screenshots -> tests/shots/
node balance.js      # bot players over many simulated runs. Targets: idle lasts a few minutes, casual player ~15 min
                     # (bots do not play mini-games, so humans who do will last a bit longer)
```
If `npx playwright install chromium` is needed on a machine without Chrome, run it once in `tests/`.
After changing CONFIG balance values, re-run `node balance.js` and check the targets still hold.
