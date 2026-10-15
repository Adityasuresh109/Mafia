# Mafia Night — production release and rollback runbook

Worker: `ad-arcade-mafia-night`  
Production URL: https://ad-arcade-mafia-night.adityasuresh2110.workers.dev  
Deployment: Cloudflare Workers; SQLite-backed Durable Objects persist separately from Worker versions.

## Pinned, production-verified stabilization release

- Source commit (game and runtime): `e491178d7e8755c2252e0ef43831a3f09bc7d992`
- Cloudflare version ID: `34da72d7-3ec5-4be4-b684-ccaa7a0ba177`
- Production verification: https://github.com/Adityasuresh109/Mafia/actions/runs/38823567567 (successful second attempt).
- Evidence: **33/33 automated tests**, real Cloudflare **60-second runoff alarm**, Doctor save, two rounds of Police checks, revealed roles, persisted public history, restricted voting and Town victory; basic room/join/host-recovery security smoke passed.
- The deployment workflow was subsequently switched to **manual dispatch only**, with serialized deployments. Workflow/docs commits after the source commit do not change this pinned Worker version.
- **Rollback target:** Use this version ID as the first-choice known-good rollback target until a newer version passes the same gates.

## Known-good release before stabilization

- Source commit: `4aa40eec0e84c82170b1472ecfa5923e67467e68`
- Cloudflare Worker version ID: `27e3e032-4843-4284-8618-668c45142ebc`
- Evidence: successful GitHub Actions run https://github.com/Adityasuresh109/Mafia/actions/runs/38819082278 (attempt 2): tests, live room flow and production smoke passed.
- Caveat: that version contains the auditor's **runoff timer defect**. It is a fallback baseline, **not** a recommended party-night release.

## Before the party

1. Confirm the final release's GitHub Actions `Deploy Mafia Night to Cloudflare` run is green, including the end-to-end smoke test.
2. Copy that run's `Current Version ID`, the deployed Git commit SHA, and its run URL into the party checklist. That is the **new pinned known-good release**; the historical version above is only an emergency fallback.
3. Perform a real-device rehearsal with the host and several guest phones. Keep host recovery link private.
4. Freeze deployments **at least 24 hours before the party**. After stabilization, automatic `main` deployments are disabled: releases require an authorized manual workflow dispatch from GitHub Actions.
5. Avoid deploying new features during a live game.

## Rollback on Cloudflare

The recommended method is Cloudflare Dashboard → Workers & Pages → `ad-arcade-mafia-night` → Deployments → select the last verified version → ⋯ → Rollback.

Or, from a trusted terminal with permission to deploy:

```bash
npx wrangler versions list --name ad-arcade-mafia-night
npx wrangler rollback <KNOWN_GOOD_VERSION_ID> --name ad-arcade-mafia-night --message "Emergency rollback to verified Mafia Night release"
```

**Verify** the production URL after rolling back by creating a disposable room, joining with a guest, and checking the host state/recovery. Do not publish host credentials or use existing player rooms for smoke testing.

**Important:** Cloudflare Worker rollback does **not** roll back Durable Object game data. These stabilization fields are additive/backwards-compatible, but going backward across future schema changes may be unsafe. Confirm the data compatibility before a rollback. An automated deployment or git revert can immediately overwrite a dashboard rollback if auto-deploy is enabled.

Cloudflare official documentation:
- https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/
- https://developers.cloudflare.com/workers/wrangler/commands/workers/

## Release freeze and manual deployment

After stabilization has been verified and deployed once, `.github/workflows/deploy.yml` will be changed to `workflow_dispatch` only, with deployment concurrency serialization. To release later: GitHub repository → Actions → `Deploy Mafia Night to Cloudflare` → Run workflow (main). The workflow runs tests, deploys, and checks live room behavior. If smoke checks fail **after** upload, production may already be serving the new version; immediately execute the rollback above.

## Operational constraints

Current per-room WebSocket limit after stabilization: 64 sockets, allowing 31 party devices with connection churn. Lightweight per-IP in-memory throttling is a nuisance defense, not distributed DDoS protection; Cloudflare-level rate limiting requires separate account-specific configuration. Keep within the free-tier quotas. Always perform a physical iPhone/Android rehearsal before a major party.
