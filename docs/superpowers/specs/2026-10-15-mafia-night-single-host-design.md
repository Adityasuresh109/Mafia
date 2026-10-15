# Mafia Night — Single-Host v1 Technical Design

**Status:** Proposed for product-owner review; **not implemented**.
**Date:** 2026-10-15.
**Source:** *Mafia Night BRD v2.0* (2026-10-15), with the subsequent owner-approved **exactly one non-playing host per room** scope amendment.
**Precedence:** This document supersedes all one-or-two-host/co-host requirements and related two-host acceptance criteria in BRD v2.0. All other BRD requirements remain in scope. Do not claim the production game is complete before full end-to-end and device testing.

## Goal

Build a premium, phone-only, real-time Mafia party game for **7–30 players and exactly 1 non-playing host**, with no accounts, no TV, no voice/video service and no required paid infrastructure. Players join using a unique six-character room code. Host moderates the classic eyes-closed ritual from a phone; confidential information is protected server-side.

## Chosen approach and alternatives considered

**Recommended:** Cloudflare Worker + per-room SQLite-backed Durable Object + WebSocket hibernation, React/TypeScript mobile web UI and a testable pure game engine. It centralizes authority and secrets in one stateful room, prevents host phone refresh from resetting the party, and targets Cloudflare's free tier (subject to actual billing/usage and deployment verification).

Alternative A, an ordinary Node/WebSocket server with a database, adds hosting/operations. Alternative B, an existing Mafia repository fork, inherits incompatible privacy, role and voting rules. Use open-source examples as patterns only when licensing is verified.

## Scope: exactly one host

- Room creation provisions **one host identity** with an unguessable 256-bit recovery credential; host **does not count** toward the 7–30 player limit.
- Only that authenticated host can lock the lobby, change configuration, deal roles, advance/finalize phases, override group night actions, manage timers, view private host dashboards, close votes, replay and end the room.
- A host reconnecting from the **same or a different phone** reclaims the same identity and current game state via a private recovery credential, without adding another host seat. A replacement host connection may supersede or revoke an earlier connection (one controlling host session at a time).
- No co-host onboarding, host PIN, second host seat, shared control, co-host takeover, or simultaneous-host resolution UI in v1. Stale/replayed host commands must still be rejected using a room version or unique command ID to prevent double transitions after retries.
- Later multi-host support is a possible future version, but has no implementation requirement or reserved UI in v1.

## Product rules retained from BRD v2.0

1. Lobby: generate six-character room codes avoiding ambiguous characters; guests join by code and 2–20-character display name, auto-suffix duplicates. Host can remove people before lock. **At least 7 guests** to lock; late joining prohibited.
2. Configuration after lock: Mafia ≥1 and <50% of players; Police 0–3; Doctors 0–3; civilians automatically calculated; K/S/C in 1–3; 1–2 eliminations per vote; discussion 60/120/180/300 seconds. Preserve BRD 7–10, 11–15, 16–22 and 23–30 presets, with validation that action counts are legal for the current eligible targets.
3. Cryptographically random role dealing; a player phone receives only its own role. Host sees the full role roster. Teammate identities are **never** labeled or separately enumerated on player screens.
4. Phase machine: `LOBBY → CONFIG → DEAL → NIGHT_MAFIA → NIGHT_DOCTOR → NIGHT_POLICE → MORNING → DISCUSS → VOTE → [DISCUSS_2 → VOTE_2] → RESULTS → NIGHT_MAFIA` with `GAME_OVER` after a winning elimination. Host navigates with guided narration. Acting teams with zero living members are automatically skipped.
5. Mafia selects K other eligible players, with mafia-on-mafia selection rejected **server-side**. The target list still contains **all living guest names** without role annotations, avoiding revealing teammates by omissions. Doctors may save themselves. Police cannot check themselves.
6. Night group consensus is the intersection across the submissions received from living group members. One valid submission gives provisional consensus; additional submissions can remove it. Host finalizes unanimous selections, resolves most-voted selections with explicit cutoff tiebreaking, or skips. Never silently finalize from an unresolved tie.
7. Saved targets negate matching Mafia kill targets. The host sees anonymous per-target convergence and saved overlaps. Police who submitted get immediate private Mafia/not-Mafia results on phase finalization (including checks on a player killed that night). No Police verdicts are sent to the host.
8. Host receives a scripted morning result and explicitly announces it; death names and roles are not broadcast before announcement. Discussion timer uses a persisted absolute deadline, and can end early via host or advance on natural expiry.
9. Living guests cast one locked, non-self ballot or abstain. Only host sees voter→target mapping and running tallies. Top-N plurality with a tie at the cutoff enters 60-second secondary discussion, then a restricted runoff of tied candidates. Persistent tie or no decisive runoff eliminates **nobody** that round, including any uncontested primary leader (BRD all-or-nothing rule).
10. After actual night/day elimination: zero living Mafia gives Town victory; Mafia count ≥ living non-Mafia gives Mafia victory. `GAME_OVER` reveals full roster. `PLAY_AGAIN` keeps player identities and returns to configuration, but cannot reset an active game without an explicit ending action.

## Architecture and trust boundaries

- `src/engine/`: pure deterministic domain rules (state transitions, validation, consensus, voting, parity, view projections). Inject clock and secure shuffle source; never network/storage in the engine.
- `worker/`: Worker routing, room creation, secure join/reclaim, Durable Object command gateway, WebSocket hibernation/persistence, per-room alarm scheduling, rate limiting, command idempotency and recovery.
- `src/client/`: single mobile web app with `HOST` and `PLAYER` views. Present role reveal, night actions, sleep screens, private feedback, synchronized timer, voting, host script and dashboard. Phone UX must remain accessible in dim lighting.
- Every server response is projected for the authenticated recipient before transmission. Guest sockets never receive another player's secret role, private vote mappings, teammates, night ballots, or other officers' Police reports. The host is authorized for roster/role and tallies **except Police verdict payloads**.
- Use 256-bit CSPRNG credentials, never put host recovery secrets in join QR codes, ordinary URL queries, chat broadcasts, or diagnostic logs; if a private recovery link is offered, carry its credential in the URL fragment and clear it after claiming. Guard against XSS and unauthorized host reclaim. Host and player identity tokens survive ordinary refresh.
- Room changes are atomic and versioned; all clients receive fresh authorized snapshots on reconnect. Durable Object alarm handles deadline expiry. No player device or host browser is game-state authoritative.
- Distinguish connectedness from living/dead status. A disconnected player retains their seat; host sees the status. Commands submitted after a deadline, from a removed player, from a dead actor or during the wrong phase are rejected.

## Verification and release gates

- Domain unit tests: validation/presets, role distribution, private role views, no target omission identity leak, consensus including dissent, host override/tiebreak/skip, exact save overlaps, private Police feedback, both vote tie outcomes, vote abstention, parity, replay.
- Backend tests: exactly-one-host room creation, no co-host route/PIN, unauthorized host command rejected, only original host recovery credential permitted, replacement-host reconnect, duplicate/stale transition blocked, 7/30 admission boundaries, per-recipient WebSocket redaction, durable restart/reconnect, alarm-driven discussion expiry, join-rate limiting.
- Browser tests: iOS Safari + Android Chrome end-to-end host and guest flows, touch targets and error screens, early discussion end, secret ballots and reconnect after tab refresh or device sleep.
- **Updated acceptance scenario:** **21 players + 1 host** join; host configures 5 Mafia, 2 Police, 2 Doctors, K2/S2/C2 and 2 eliminations; all retained BRD phase/secrecy/action/tie/win examples pass. Load-test at least **30 players + 1 host** (31 concurrent seats), including disconnect/reconnect. Real-device test before declaring release ready.
- Deployment credentials stay outside the repo. A GitHub repository or static demo is **not** a live multiplayer release; claim a live URL only after production Worker deployment is verified.

## Milestones

1. Ratify this one-host design against BRD v2.0; finish one-host game engine contract and failing-first domain tests.
2. Durable Object room/authentication/WebSocket adapter and persistence, including host recovery.
3. Polished host and player mobile views with browser integration tests.
4. Automated deployment, security/load testing and cross-device acceptance; then v1 release decision.

## Explicit exclusions for v1

Co-host support, host PINs, simultaneous host operators, custom roles, accounts, TV UI, in-app voice/video, spectators, joining after game start and paid hosting dependencies.
