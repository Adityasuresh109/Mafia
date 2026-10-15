# Mafia Night — Single Host Implementation and Verification Plan

**Source:** `docs/superpowers/specs/2026-10-15-mafia-night-single-host-design.md` (already committed in main).

## Delivered in the development archive

- Pure one-host state machine: `src/engine.js`.
- Durable Object storage, replay-safe host commands, per-client filtered WebSockets, alarm-based discussion: `worker/index.js`.
- Responsive phone-only UI: `public/index.html`, `public/styles.css`, `public/app.js`.
- Unit and simulated transport verification: `tests/engine.test.js`, `tests/worker.test.js`.

## Remaining release gates

- [ ] Cloudflare Wrangler **local runtime** integration (was not available in this disconnected development container).
- [ ] Test real WebSocket hibernation and 31 concurrent connections under cloud runtime.
- [ ] Add admission/IP abuse protection and cap unauthenticated WebSocket connections.
- [ ] Test the interface on iPhone Safari and Android Chrome with 7–30 real devices.
- [ ] Game-moderator rehearsal covering every K/S/C configuration, ties and operator errors.
- [ ] Verify deployed Workers URL and add production deployment credentials securely.
- [ ] Confirm host recovery on another device and after browser privacy-data changes.

## Release policy

Unit tests and a local mock Durable Object do **not** constitute a production multiplayer certification. An unverified deployment URL must never be presented as live. Keep this build tagged as pre-release until the above checklist passes.
