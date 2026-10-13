# Architecture and evidence

The executable entry is `src/cli/main.ts` → `dist/cli/main.js`. Runtime code is strict TypeScript compiled to Node ESM. A CLI parent supervises a worker; trusted hooks run in that worker. The small SDK contains pure assertions and helpers, without browser pages in seed/cold/upgrade assertion hooks.

## State machine

`validate → prepare → old-ready → seed-complete → before-captured → browser-closed → gateway-switched → new-observed → new-ready → after-captured → assertions → report → cleanup`

Control and upgrade legs each record the browser phases and evidence. Control's second observation is OLD, despite the shared phase name `new-observed`; `kind`, expected IDs and backend phase make this explicit. Control owns one fresh profile; main owns another. Their seed input digest and author-selected logical fingerprints match. Captured time and physical profile identity are excluded by the example's explicit normalization rules; fixed application timestamps remain part of the fingerprint and contracts.

The persistent context is fully awaited closed. CDP observes Chromium's actual userDataDir and process ID. The browser must disconnect and its root process must exit before the gateway switches. A forced OLD close prevents a clean lifecycle verdict. PIDs and private paths are used internally for ownership; public run JSON exposes opaque profile IDs and confirmation booleans. The SDK snapshots never carry state into another browser.

Node's challenge includes a fresh nonce, the overall run ID, phase and active immutable build hash. It runs outside the page/service-worker fetch path. A DOM attribute set by versioned application JS supplies the independent executed identity. Authors must keep the initial sentinel absent from HTML and avoid setting it from a runtime gateway phase. Honest sentinel integration is an application responsibility; this is not adversarial code attestation.

## Gateway and resources

The built-in server binds only `127.0.0.1`, once, on a free automatic or explicit port. Active-root changes are internal operations. `/__originrehearsal__/phase` is GET-only and read-only. Reserved paths cannot be part of a dist. Decoding, traversal, realpath containment, symlinks, absent assets and read failures are checked; no directory listing exists. SPA fallback requires explicit opt-in, HTML acceptance and an extensionless path. Missing JS never becomes index.html.

Build hashing sorts relative paths globally and hashes length-delimited paths/content. Dist roots and files must remain immutable. Requested file hashes and full phase-boundary rescans detect changes; these yield ERROR. Symlinks in builds are rejected. Limits are 10,000 files/build, 64 MiB/file and 256 MiB/build. These bounds apply to the supported static transport, not a reverse proxy.

Case limits: phase timeout 500–120,000 ms, 1–100,000 records/store, 256–50,000,000 bytes/snapshot. Defaults are 30,000 ms, 1,000 records and 5,000,000 bytes. API work has bounded timeouts. The CLI supervisor gives a phase an additional 3 seconds to report timeout, then 5 seconds for graceful cancellation before verified owned-process termination. It confirms exit after terminating a stalled worker, handles the brief zombie interval, and only removes a root whose marker and known profile identities match. Arbitrary hook code is not a sandbox and may create resources outside this ownership model; run only trusted hooks.

## Snapshot semantics

Each selected localStorage key, database and store has `present`, `missing`, `error` or `unsupported`. A store can be present with zero records. A missing store is a readable fact, not an operational error. Records have supported native keys and JSON values. Listing/open races abort accidental database creation. Transactions wait for completion and connections close, including on version change. Missing is never used for a timeout or read denial.

JSON validation runs inside the browser before Playwright serialization. Unsupported typed values/keys and cycles preserve a reason and withhold incomplete record lists. Exceeding total bytes withholds observations; it cannot yield a truncated complete snapshot. SDK helpers refuse operationally unreadable observations, and invalid localStorage JSON is a hook/contract error. Preserved nullable fields retain null distinctly from absent fields.

Targets are selected coverage, not an inventory guarantee. Cookies, OPFS, unselected keys/stores, indexes, constraints and cache data are outside v0.1's contracts. Unsupported/error observations stop evaluation, with ERROR precedence. A migration abort or readiness failure has no AFTER data-loss verdict.

`captureStorage` enumerates databases, then reads each selected store using `db.transaction(name, 'readonly')`; localStorage keys and other stores are observed separately. A readonly transaction supplies consistency within its own scope, as defined by [IndexedDB transaction scheduling](https://www.w3.org/TR/IndexedDB/#transaction-scheduling). There is no shared transaction across the origin. Readiness is an application contract, not a lock: authors should await committed writes and migration before signalling readiness, then pause writers affecting declared targets through capture. This guidance follows the actual separate transaction scopes; arbitrary background writes can change state between stores or between observations. No application lock or stronger atomicity guarantee is implemented.

The supported native keys remain strings and finite numbers. IndexedDB [key comparison](https://www.w3.org/TR/IndexedDB/#key-construct) considers type as well as value; number `1` and string `"1"` are different records. HTML uses a serialized tuple `(subject kind, database, store, key type, key value)` for record identity, with shorter tuples for localStorage/database/store subjects. Display labels quote opaque names and show key type, but never determine identity. Presence is checked separately from the value, preserving present null and falsy values; tagged operational observations are copied unchanged. Raw snapshots and SDK/runner semantics are unaffected.

## Config input schema

`scripts/build-example.mjs` uses [Zod's input representation](https://zod.dev/json-schema#io) with `{ io: 'input' }`. The published schema is draft 2020-12; defaults annotate optional user fields rather than requiring runtime output fields. Strict objects still reject unknown properties. `uniqueItems` metadata mirrors existing runtime uniqueness refinements for localStorage keys, store names and identical database target objects; it does not replace or weaken those refinements.

`npm run verify:schema` uses pinned development-only Ajv2020 with strict schema validation and no default insertion, type coercion or property removal. It checks every shipped `*-case.json`, a minimal input, partial/empty defaults, JSON seed values, positive/negative bounds and duplicate targets. It also compares the checked-in schema bytes with a newly generated input schema. CI builds, runs parity and requires no generated schema/example diff.

Some semantic validation cannot be represented by this generated standard schema and stays explicitly at runtime:

| Rule | Enforcement |
| --- | --- |
| OLD and NEW build IDs differ | `caseSchema` cross-field refinement |
| Database names are unique even if store lists differ | `caseSchema` name-based refinement; JSON Schema `uniqueItems` only compares whole objects |
| At least one localStorage/database target is declared | `caseSchema` refinement across target arrays |
| Hooks explicitly name a local `.mjs` regular file with required exports | `loadCase`, filesystem checks and trusted module loading |
| App path stays on the gateway origin and avoids reserved paths/backslashes | `loadCase` origin/path checks; schema only requires an initial slash |
| Build paths exist, are immutable static builds, contain no symlinks and stay within resource limits | `loadCase` / `inspectBuild` / gateway phase checks |

Parity fixtures name expected schema/runtime differences for the first three refinements. Filesystem, hook/path policy and other live checks are covered by the existing unit/lifecycle suites. Editor schema acceptance alone never establishes that a case is safe or runnable. Hooks and imports remain trusted local code, with the user's rights.

## Performance evidence

`npm run benchmark:snapshots` uses three fresh child processes and fresh owned profiles for each of two synthetic states: 1,000 records with 128-byte string values, and 100,000 records with 470-byte strings (near the 50,000,000-byte snapshot ceiling). Each read uses the production readonly probe, verifies every numeric key/value and an independent native count, and confirms browser close and profile/gateway cleanup. Limits are 120 seconds per phase, a 150-second browser-work deadline and a 2 GiB Node heap budget. No personal profile or production data is used.

Results include seeding/capture/serialization times, exact serialized snapshot bytes, formatter elapsed time and output bytes, Node peak RSS (`resourceUsage().maxRSS`, converted from KiB), and 250 ms RSS samples of this owned browser's known process IDs. Browser RSS samples can miss new processes or brief spikes and can count shared memory multiple times. They are not an exact total machine peak. Each component result records runtime/browser/OS versions.

The formatter measurement deliberately uses the same real observed snapshot twice in a formatting fixture; it is never saved as a cold-update report. This measures a two-snapshot presentation cost, not a full control+upgrade four-snapshot lifecycle at maximum state. Large captures are expensive and output size expands with repeated snapshots and HTML rows. The CLI's saved-report input ceiling remains 50,000,000 bytes for the entire JSON file, independently of the per-snapshot bound. Benchmarks are local measurements, not a latency or memory SLA or a claim of verification on other operating systems.

## Reports and publication

JSON schema version is 1. The report stores expected build IDs, build hashes, executed app evidence, seed identity, both leg IDs, timing, observations, assertions, errors and cleanup. Hook digest covers the named entry module, not transitive imports. Reports contain selected data and must be handled accordingly.

HTML contains inline static CSS and one fixed control script. Data is rendered only as escaped text/preformatted JSON; no embedded data is executable and closing script tags cannot escape. Native details work without JavaScript. Search and outcome filters use text content. UI checks use real report files with HTTP requests disabled.

CI runs real Chromium on standard public-repository GitHub-hosted runners with minimal read-only permissions. The Pages deploy is a separate trusted branch job in the same workflow, dependent on all verification jobs, using only an allowlisted `site/` artifact. Release archives are downloaded from the exact-SHA CI consumer-tested artifact and uploaded unchanged. The release manifest records provenance; no published tag or archive is silently replaced.

## Existing tools

Primary references were reviewed before implementation. No source code from these projects is copied into this project.

- [Playwright persistent context](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context) provides real persistent storage; closing its context closes the browser.
- [Playwright storage state](https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state) already supports snapshots including IndexedDB and, in supporting versions, OPFS. OriginRehearsal does not invent these mechanisms or use snapshot restore as the upgrade path.
- [fakeIndexedDB](https://github.com/dumbmatter/fakeIndexedDB) is an in-memory API implementation for tests, not a proof of a real restarted browser.
- [Dexie](https://github.com/dexie/Dexie.js) and [Version.upgrade](https://dexie.org/docs/Version/Version.upgrade()) supply migration mechanisms; preservation expectations remain application-specific.
- [Whiteboard's browser migration tests](https://github.com/kamiazya/whiteboard/blob/main/apps/web/src/lib/browser-idb-migration.browser.test.tsx) demonstrate substantive IDs/links/content assertions and intentional deletion. Its fresh native fixture tests are useful application testing; retained-profile cold upgrade evidence is OriginRehearsal's explicit lifecycle.
- MDN: [databases](https://developer.mozilla.org/en-US/docs/Web/API/IDBFactory/databases), [open](https://developer.mozilla.org/en-US/docs/Web/API/IDBFactory/open), [readonly transactions](https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction).
- GitHub: [custom Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
