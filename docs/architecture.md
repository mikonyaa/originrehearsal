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
