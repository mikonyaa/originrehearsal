# Changelog

## Unreleased

- Preserve each supported IndexedDB record in selected-values HTML using typed subject identity; number/string keys, slash-containing names and database/store/record subjects no longer collide. Preserve present JSON null and falsy values separately from absent observations.
- Generate draft 2020-12 case schema for user input before runtime defaults, retaining strict validation. Add a deterministic Ajv2020 parity gate for shipped/minimal cases, bounds and negative fixtures; document runtime-only refinements and live filesystem/hook policy checks.
- Add renderer regressions and an independent installed-package Chromium consumer with OLD/GOOD/BAD builds, public SDK imports, separate expected values, typed keys, null/falsy JSON, missing records, slash names and complete offline summary/raw comparisons.
- Regenerate sample HTML from retained v0.1.0 JSON with explicit provenance notices; original captures and release media are unchanged. Add bounded synthetic snapshot/formatter measurements and clarify per-store readonly consistency.

This is local unreleased work. The pinned runtime dependencies, native probes, runner lifecycle, ownership, outcome codes and supported storage scope are unchanged. Fresh external CI, cross-platform sandbox verification and a real application pilot have not been established by these changes.

## 0.1.0

First experimental public release: immutable static OLD/NEW gateway on one loopback origin; separate OLD cold control; real retained Chromium profile lifecycle; backend challenge and executed sentinel evidence; selected read-only localStorage/IndexedDB probes; explicit seed/cold/upgrade contracts and compiled SDK; classified exit codes; offline JSON/HTML reports; standalone notes example, native negative fixtures and recorded synthetic demo.

Limited to Node 24 LTS, macOS arm64 and Linux x64, prepared static builds, no-store cold updates and supported JSON data. Service workers, OPFS, production auth/cache parity, SSR and multiple-tab rehearsals are outside coverage. No npm-registry publication or external user validation is claimed.
