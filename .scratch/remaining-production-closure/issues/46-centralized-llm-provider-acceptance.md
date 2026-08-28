# 46 — Centralize real LLM provider acceptance evidence

**What to validate:** Run every closure validation that requires real LLM/model-provider credentials and network access, after implementation tickets have merged without embedding secrets or faking provider evidence.

**Blocked by:** None for environment preparation. **Execution dependency:** selected final integration candidate after Tickets 32–35 implementation merges. **Final consumer:** Ticket 35 deterministic decision.

**Status:** ready-for-human

## Tracked scope

This ticket centralizes external LLM-provider acceptance that cannot run in the coding-agent environment because provider endpoint and API key are deployment secrets. It does not authorize fixture walkers, provider fakes, skipped repetitions, or synthetic evidence to satisfy release claims; it only defers those real-provider checks into one explicit human-operated validation pass. Ticket 21 is resolved; under the 2026-08-27 two-phase authority, credential/environment preparation may occur now, while the real-provider commands execute in parallel with Ticket 31 only after the final integration candidate is selected. Ticket 35 consumes the resulting immutable redacted evidence before any frozen/release conclusion.

## Provider environment inventory

Required Reference Benchmark variables:

- `QUALIGENCE_REFERENCE_MODEL_BASE_URL`
- `QUALIGENCE_REFERENCE_MODEL_API_KEY`

Supported legacy aliases:

- `QUALIGENCE_MODEL_BASE_URL`
- `QUALIGENCE_MODEL_API_KEY`

Live CLI smoke additionally requires:

- `QUALIGENCE_LIVE_MODEL_SMOKE=true`
- `QUALIGENCE_MODEL_NAME`
- `QUALIGENCE_DATA_DIR`

## Validation inventory

Run these with real provider/network credentials and record redacted evidence only:

```bash
CI=true corepack pnpm vitest run tests/e2e/detection-benchmark/reference-model-profile.test.ts
CI=true QUALIGENCE_LIVE_MODEL_SMOKE=true corepack pnpm vitest run tests/live/remote-model-smoke.test.ts
```

Relevant provider-env code/tests found during inventory:

- `apps/benchmark-runner/src/reference-model-provider.ts`
- `tests/e2e/detection-benchmark/reference-model-profile.test.ts`
- `tests/live/remote-model-smoke.test.ts`
- `apps/cli/src/config.ts`
- `apps/local-launcher/src/config.ts`
- `apps/local-launcher/src/main.ts`
- `apps/local-launcher/src/doctor.ts`
- `tests/e2e/cli-web-cart.test.ts`
- `tests/e2e/local-launcher.test.ts`
- `docs/testing/windows-m3-manual-checklist.md`

## Acceptance

- Real Reference Model benchmark runs every Detection Benchmark v1 scenario and repetition through the configured frozen provider/profile and produces a durable `profileStatus: reference`, `gate.status: passed` report with persisted model invocation evidence.
- Live remote-model smoke runs against a real provider and proves no API key leaks into stdout, stderr, persisted invocation summaries, artifacts, or local files.
- Evidence records include command, commit SHA, redacted environment shape, provider/model identity, report hash, invocation count, and log/artifact locations. Never store API keys, plaintext prompts containing secrets, customer data, or provider raw credentials.
- Any provider/network/credential failure is recorded as `needs-info` with stable error output, not converted into a synthetic pass.

## Comments

- start — Created by maintainer direction to consolidate LLM-provider credential/network validation. Current code tickets that require external LLM provider evidence may merge after code review and deterministic gates, while this ticket owns the deferred real-provider validation before final release claims.
- update - 2026-08-27: Maintainer authorized code-first closure. Ticket 46 remains human-owned: prepare credentials/environment without recording secrets, then execute the two real-provider commands on the selected final integration candidate in parallel with Ticket 31. A provider/network/credential failure remains `needs-info` and blocks Ticket 35; it is never converted to a synthetic pass.
