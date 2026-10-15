# Mafia Night · AD Arcade

A dramatic, phone-only Mafia / Werewolf party game for **7–30 players plus exactly one non-playing host**. No accounts, no TV and no paid service required within applicable Cloudflare free-tier quotas.

**Status:** pre-release build, not verified live. Real-device playtest and Cloudflare deployment still required.

## Gameplay

- Host creates a room, copies the join link, and locks the lobby with 7–30 people.
- Host sets Mafia (less than half), Police (0–3), Doctors (0–3), kill/save/check counts (1–3), and eliminations (1–2).
- Everyone checks their own secret role on their phone. Only the host sees the full role roster.
- Host guides the night: Mafia → Doctor → Police. Each group privately locks choices, with unanimous consensus or host tie resolution.
- Police receives confidential verdicts. Host announces night casualties. Players debate, then cast silent votes.
- A vote tied at the cutoff goes to a 60-second second discussion and limited runoff; unresolved ties eliminate nobody.
- Town wins when every Mafia dies. Mafia wins at or above parity with living non-Mafia.

## Run locally

Requires Node.js 22+ and a recent Wrangler CLI.

```bash
npm test
npm install --no-save wrangler
npx wrangler dev
```

Open the local URL Wrangler prints. To join from real phones, use a public secure preview/tunnel or deploy to Cloudflare Workers. The `public/` folder alone can display the landing page but **cannot** host a multiplayer game without the Worker.

## Deploy (Cloudflare)

1. Create or sign in to a Cloudflare account and enable the free Workers plan.
2. From your own trusted development environment, run `npx wrangler login`.
3. Run `npx wrangler deploy` at the repository root.
4. Open the verified `workers.dev` URL. Use **Create Room** on the host phone and send the provided guest link to your party.

For automation, add Cloudflare deployment secrets to GitHub Actions instead of committing tokens. Follow `wrangler.toml` for the SQLite-backed Durable Object binding. GitHub Pages alone is insufficient; the Worker is required for authenticated real-time multiplayer.

## Structure

- `src/engine.js` — dependency-free, server-authoritative rules and secret-scoped views
- `worker/index.js` — Worker APIs and WebSocket-hibernatable room state
- `public/` — static host and player mobile interface
- `tests/` — domain and simulated Durable Object API tests
- `docs/superpowers/` — one-host design and release gates

## Safety and limits

- Host recovery links contain private secrets. Share them only with the host. Guest links contain room codes only.
- This version exposes no co-host endpoint and no four-digit PIN.
- Avoid screen peeking during the role reveal; there is no in-app identity list for other living players.
- The app protects roles and votes on the server. Do not broadcast the raw server state object.
- **A passing mock test suite is not a substitute for testing in Cloudflare and with 30 real phones.**
