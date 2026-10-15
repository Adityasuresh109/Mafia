# Mafia Night — AD Arcade

A phone-only, host-moderated Mafia party game, based on **Mafia Night BRD v2.0 (2026-10-15)**. Intended for 7–30 players and 1–2 non-playing hosts.

## Current status: Engine milestone (not playable online yet)

This repository begins with an isolated, testable game-rule engine. The Cloudflare Durable Object backend, real-time transport, browser UI and public deployment are **not yet implemented**. Do not use this branch as a real party server or claim it supports 30 connected devices.

Run `npm test` using Node.js 22 or later (no install or paid services required for current tests).

- [Technical design](docs/superpowers/specs/2026-10-15-mafia-night-design.md)
- [Step-by-step implementation plan](docs/superpowers/plans/2026-10-15-mafia-night-milestones.md)

## Non-negotiables

All private roles, actions, choices, and individual votes must be redacted on the server according to the authenticated user; phones must never receive a different living player's role. Co-host and reconnect tokens must not leak into room URLs. All requested game mechanics are ultimately gated by BRD acceptance tests and real-device load testing.

This project source remains all-rights-reserved (`UNLICENSED`) until the owner chooses a distribution license. Third-party source code is not copied into this repository.