# SciBowl Practice

A static Science Bowl practice site: a searchable catalog of **36,145 real questions** parsed from **875 packet PDFs** across **66 tournaments** on [scibowl.live](https://www.scibowl.live/packets), plus a solo read-aloud buzzer trainer and a live host/join multiplayer mode. Pure static HTML/CSS/JS — no backend, no build step, no server-side code. Deployable directly to GitHub Pages.

## Pages

- **`index.html`** — landing page / navigation.
- **`catalog.html`** — browse and search all 36,145 questions. Filter by subject, difficulty, question type, format, and tournament; bookmark questions for later.
- **`solo.html`** — solo practice. Questions are read aloud (adjustable speed) with a buzz-in window (4s tossup / 20s bonus), then 10s to type an answer. Auto-grades against Science Bowl answer conventions (accept/reject lists, "1 and 2" ↔ "12" digit-list equivalence, MCQ letter or full-text matching), with manual override. Score: +4 correct, 0 incorrect after full read, −4 incorrect if you buzzed early. Supports pausing, bookmarking, and playing bookmarks-only.
- **`multiplayer.html`** — host a room or join one with a code. Everyone can buzz; once someone buzzes, everyone else is locked out until they answer; a wrong answer locks that player out of the rest of that question. Anyone can advance to the next question once the answer is revealed. Live scoreboard for all players.

### Keyboard shortcuts (solo)
`Space` buzz in · `Enter` submit answer · `N` next question · `S` skip · `Q` override grading · `B` bookmark · `P` pause/resume

### Keyboard shortcuts (multiplayer)
`Space` buzz in · `N` next question (once revealed) — no pause, since it's a shared game.

## How it works

- **Data**: `data/questions.json` (~16MB, gzips to ~3.5MB — GitHub Pages/Fastly serves it gzip-compressed automatically) and `data/meta.json` (tournament list, subject labels, counts) are loaded client-side on every page via `js/data.js`.
- **Text-to-speech**: the browser's built-in Web Speech API (`speechSynthesis`). No external TTS service.
- **Multiplayer**: peer-to-peer over WebRTC via [PeerJS](https://peerjs.com/) (loaded from a CDN), using PeerJS's free public cloud broker only to establish the connection — no game data touches a server. The host holds the authoritative game state (timers, scoring, question order); the room "code" is literally the host's PeerJS peer ID. This was verified working end-to-end (two independent browser peers exchanging messages over a real WebRTC data channel) during testing.
- **Bookmarks**: stored in the browser's `localStorage`, per-device.

## Deploying to GitHub Pages

1. Create a new GitHub repository (or use an existing one).
2. Copy everything in this `site/` folder into the repo root (so `index.html` sits at the repo root, not in a subfolder) — or push it to a `docs/` folder and point Pages at `docs/` instead.
3. Push to GitHub:
   ```bash
   git init
   git add .
   git commit -m "SciBowl practice site"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
4. In the repo on GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, folder `/ (root)` (or `/docs` if that's where you put it). Save.
5. Your site will be live at `https://<you>.github.io/<repo>/` within a minute or two.

No build step, no `npm install`, no environment variables — it's just static files.

## Data notes / known limitations

- **36,145 questions** were parsed from 875 packet PDFs across 66 tournaments (all tournaments listed on scibowl.live/packets that had a downloadable, text-based packet).
- **34 packets (≈4%)** yielded no extractable text — these are mostly scanned-image PDFs (no embedded text layer) rather than parsing failures; an entire tournament ("LOST 2", 13 rounds) falls in this category and would need OCR to include.
- **Difficulty (RR/DE)** is only encoded in the source filename for a minority of packets — most questions show `Unknown` difficulty rather than a guess.
- **Answer text cleanup**: roughly 9% of raw answers had trailing packet-header text (tournament name/page number bleeding in from the PDF layout) automatically stripped during a cleanup pass; this was spot-checked but a small number of edge cases may remain imperfect. If you spot a wrong/truncated answer while practicing, the "Source" link on each catalog card points back to the original packet PDF so you can verify against the source.
- Every question keeps a link to its original packet PDF as the source of truth.

## Local development

Any static file server works, e.g.:
```bash
python3 -m http.server 8000
```
then open `http://localhost:8000/`.
