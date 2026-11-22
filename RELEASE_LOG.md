# Release Log

## Version 4 — Automated Delivery (CI/CD and Container Builds)

- **Release date:** 2026-11-22
- **Release type:** Infrastructure and delivery update — no application or engine changes

### Added

- GitHub Pages deploy workflow rebuilt for the root-level app: the WASM engine is compiled from `core/src` in CI (committed `core/pkg` artifacts are never trusted), `wasm-bindgen-cli` is installed at the exact version extracted from `core/Cargo.lock`, and `npm run lint` plus `cargo test` gates must pass before the Vite build.
- Pull-request builds on the workflow; the deploy job is gated to `main` pushes only.
- Post-deploy smoke test: the workflow curls the deployed Pages URL and asserts HTTP 200 for the index page and the fingerprinted `journal_core_bg-*.wasm` asset, retrying to absorb Pages propagation delay.
- Multi-stage `Dockerfile` (Node deps → Rust/WASM → web build → artifact image) plus `.dockerignore` and an entrypoint that extracts `/dist` to a mounted volume or launches the `journal-log-analyzer` GUI tool (`extract` / `analyze` commands; see the Dockerfile header for usage).
- OCI image labels carrying the git revision via `--build-arg REVISION`.

### Fixed

- The root lint script no longer scans the legacy `app/` copy; `npm run lint` is clean and now runs as a CI gate.
- The deploy workflow referenced the retired `app/` subdirectory (stale lockfile path, stale build directory) and would have deployed the superseded Version 0 app.

### Validation

- `actionlint` on the workflow: clean.
- `hadolint` on the Dockerfile: clean (two justified apt-pin suppressions, documented in the file).
- Docker build verified end-to-end: image builds, `import tkinter, journal_log_analyzer` succeeds inside the image, `extract` produces a `dist/` whose index page and WASM asset both return HTTP 200 with `Content-Type: application/wasm` when served.
- Local `npm run lint` and `npm run build` (TypeScript + Vite) pass.

### Notes

- `core/pkg` remains committed by design (README: ordinary builds need no Rust toolchain); CI and Docker deliberately rebuild it from source instead of relying on the committed copy.
- The GUI analyzer tool runs in the container only with X11 forwarding; the import/smoke checks above are the headless-verifiable part.

## Version 3 — Bidirectional Lazy Pagination

- **Release date:** 2026-11-23
- **Release type:** Scalability and record-navigation update

### Added

- Numbered pagination with previous/next controls and direct page jumps.
- Two hundred entries per worker page, replacing the fixed first-2,000-entry table window.
- Automatic page loading while scrolling in either direction; every filtered entry can now be browsed.
- A bounded four-page UI cache. Downward scrolling evicts the lowest cached page first, upward scrolling evicts the highest, and direct jumps evict the pages farthest from the destination.
- Loading placeholders, current-range status, cached-page status, and accessible pagination controls.
- A deterministic 1,000-entry fixture and production-browser tests covering both engines, direct navigation, forward eviction, backward reloading, and full-record parity.

### Improved

- Worker-to-UI transfer is limited to required pages rather than eagerly transferring the first 2,000 rows.
- Virtualized rendering now spans the complete filtered result while retaining at most 800 summary records in the UI cache.
- Filtering or loading a new file invalidates stale page requests and resets the table position.
- Exports remain unchanged and still retrieve every matching entry in 5,000-record chunks.

### Validation

- Production TypeScript/Vite build passed.
- ESLint passed.
- **30 production-browser tests** passed.
- **5 independent `journalctl` comparisons** passed.
- The Rust core and its previously validated five unit tests were unchanged by this UI/data-retrieval update.

### Compatibility and Privacy

- Pagination uses the existing arbitrary-index worker API; no new parser, server, persistence, or cross-origin requirement was introduced.
- Initial parsing still processes the complete uploaded input. Pagination reduces UI transfer/rendering memory, not the worker's parsed-record storage.
- Uploaded journals, records, filters, and page caches remain in memory and outside Cache Storage.

## Version 2 — Expanded Archive Support

- **Release date:** 2026-11-22
- **Release type:** Archive compatibility and offline-support update

### Added

- Fully client-side extraction for `.tar`, `.tar.gz` / `.tgz`, and `.7z` archives, in addition to existing ZIP support.
- One shared archive pipeline for the TypeScript fallback and Rust/WASM engine, with identical member selection, record limits, sorting, warnings, and parsers.
- Lazy-loaded `7z-wasm` decoder using an in-memory virtual filesystem; archive contents are never written to the host filesystem or uploaded.
- Deterministic TAR, TAR.GZ, TGZ, and 7z fixtures with matching nested journal/log contents and ignored non-log members.
- JS/WASM production-browser parity tests for every new archive format and clean malformed-7z error coverage.
- Offline precaching and an offline production-browser extraction test for the 7z JavaScript chunks and WASM decoder.

### Improved

- Worker output now uses ES modules so the optional 7z decoder can be code-split and loaded only when needed at runtime.
- Upload controls and help text list every accepted archive extension.
- The existing 500,000-record archive cap now applies consistently across ZIP, TAR, TAR.GZ/TGZ, and 7z inputs.

### Fixed

- Gzip MIME detection no longer misclassifies `.tar.gz` files as ZIP archives.
- Malformed 7z input now uses the decoder's returned exit status and reports an extraction error instead of displaying an empty successful result.

### Validation

- Production TypeScript/Vite build passed.
- ESLint passed.
- **5 Rust unit tests** passed.
- **28 production-browser tests** passed.
- **5 independent `journalctl` comparisons** passed.
- Offline reload followed by 7z extraction passed without browser runtime errors.

### Compatibility, Privacy, and Performance

- No `SharedArrayBuffer`, COOP, COEP, cross-origin isolation, server, or database is required.
- Uploaded archives and parsed records remain outside Cache Storage; only static application and decoder assets are precached.
- The 7z decoder adds approximately 1.65 MB raw / 670 kB gzip to offline precaching. It is not part of runtime execution unless a 7z archive is opened.
- Existing benchmark results remain unchanged; no new throughput claim is made for the additional archive formats.

## Version 1 — WASM-Accelerated Journal Analyzer

- **Release ID:** `d218dcd`
- **Release date:** 2026-11-22
- **Release type:** Major performance and architecture update

### Highlights

This release moves journal parsing and filtering into a Rust/WebAssembly core running inside dedicated Web Workers. The application remains fully client-side, supports static hosting, and retains the original TypeScript implementation as an automatic fallback.

The final measured synthetic-corpus result is a **1.97–2.51× median end-to-end speedup** and **2.65–2.97× lower filter wall time**. The engineering target of 3× end-to-end speedup was not reached.

### Added

- Rust core compiled to `wasm32-unknown-unknown` using `wasm-bindgen`.
- Dedicated module Web Worker for parsing, filtering, ZIP extraction, and record retrieval.
- Automatic engine selection through `?engine=auto`, with explicit `?engine=wasm` and `?engine=js` modes.
- Optional detailed phase profiling through `?profile=1`.
- Stateful in-WASM entry storage and compact, transferable `Uint32Array` filter results.
- Batched visible-record retrieval and lazy full-field decoding for record details.
- Chunked 5,000-record export retrieval to avoid a single large worker response.
- ASCII literal-filter fast path with ECMAScript-compatible fallback behavior for general patterns.
- Virtualized display of the existing 2,000-record view.
- Reproducible production-browser benchmark harness with the untouched original build preserved as the baseline.
- Deterministic correctness fixtures and an independent `journalctl -o json` oracle test.
- Offline application-shell caching for HTML, JavaScript, CSS, fonts, the worker, and WASM.
- Mobile-layout, automatic-fallback, and offline-reload browser tests.
- Build, deployment, privacy, benchmarking, and performance documentation.

### Improved

- Parsing and filtering no longer block the React main thread under normal operation.
- Plain journal payloads are borrowed in Rust instead of copied unnecessarily.
- Field-name validation no longer executes a regular expression for every field.
- Full field maps are materialized only when details or exports require them.
- Filtering and indexing run close to the parsed data rather than through per-entry JavaScript calls.
- Exports and record details load asynchronously and stale detail/filter results are cancelled.
- Detailed profiling is disabled by default because instrumentation itself reduced throughput.
- Static assets use relative URLs, allowing deployment at GitHub Pages repository subpaths.

### Fixed

- Automatic TypeScript fallback now works reliably when WASM initialization or loading fails.
- Offline reload now includes all generated worker and WASM dependencies.
- Offline cache lookup handles static-host `Vary: Origin` responses for module requests.
- Embedded `data:` font URLs are excluded from Cache Storage precaching.
- Text-record priority and absent-field normalization now match between TypeScript and WASM.
- Mobile controls and record details remain usable without horizontal page overflow.
- Initial differential tests wait for the first usable view instead of reading incomplete state.

### Performance

Measured using a deterministic synthetic 100,000-entry corpus in headless Chromium, with five fresh-browser runs per configuration and detailed profiling disabled:

| Corpus | Cache | Original median | WASM median | Speedup |
| --- | --- | ---: | ---: | ---: |
| Direct journal | Cold | 1,920.6 ms | 870.5 ms | 2.21× |
| Direct journal | Warm | 1,897.3 ms | 757.2 ms | 2.51× |
| ZIP | Cold | 2,088.9 ms | 1,061.8 ms | 1.97× |
| ZIP | Warm | 2,027.5 ms | 992.8 ms | 2.04× |

- Median filter wall time improved from approximately 270–275 ms to 92–103 ms.
- No main-thread load or filter long tasks were observed in the final WASM runs.
- Direct-journal peak RSS delta improved in the measured sample.
- ZIP memory was approximately unchanged when cold and slightly higher when warm; no general memory-saving claim is made.
- Final WASM size is approximately 1.73 MB raw and 646 kB gzip.

These are synthetic, headless-browser measurements—not claims about the unspecified real journal corpus or target device. See `PERFORMANCE.md` for p95 values, throughput, memory methodology, phase timings, failed experiments, and raw-result references.

### Correctness and Validation

- Production TypeScript/Vite build passed.
- ESLint passed.
- **5 Rust unit tests** passed.
- **22 production-browser tests** passed.
- **5 independent `journalctl` comparisons** passed for plain, LZ4, ZSTD, XZ, and keyed-hash fixtures.
- JS/WASM differential coverage includes modern, legacy, repeated-field, JSON, text, ZIP, empty, malformed, truncated, compact, and large-record cases.
- Filters, boot filtering, lazy details, AI Markdown export, Jira export, fallback, offline reload, and mobile layout were exercised in the production browser.

### Compatibility and Privacy

- Modern and legacy journal layouts, keyed-hash files, and repeated fields are supported.
- Plain, LZ4, ZSTD, and XZ objects are supported.
- JSON, text, and ZIP inputs are supported.
- Existing boot views, record details, filters, and export formats are retained.
- The existing 500,000-record ZIP limit is preserved.
- Compact-mode journal files are rejected with remediation text.
- No `SharedArrayBuffer`, COOP, COEP, or cross-origin isolation is required.
- Journal contents are processed locally and are not uploaded or written to Cache Storage.

### Deployment Notes

- Deploy the contents of `dist/` to the static host.
- Serve `.wasm` files with the `application/wasm` MIME type.
- Enable gzip or Brotli to reduce WASM transfer size.
- Use HTTPS for service-worker installation outside localhost.
- An initial online load is required before offline reload becomes available.
- Run `npm ci` before building from the source archive; generated WASM bindings are already included, so Rust is only required after modifying `core/`.

### Known Limitations

- The requested 3× end-to-end target remains unmet.
- Real-corpus and target-device validation is still required.
- JSZip extraction remains a major ZIP-path cost.
- General non-literal regular expressions still rely on `regress`.
- Rust object traversal, record construction, and string allocation remain important bottlenecks.
- The WASM module adds a significant cold-download cost.
- The installed `journalctl` cannot emit the legacy fixture; legacy correctness is covered by differential testing against the original TypeScript parser.

### References

- `README.md` — architecture, build, test, benchmark, deployment, and privacy instructions.
- `PERFORMANCE.md` — complete measured report and remaining bottlenecks.
- `tests/benchmark-*.json` — preserved raw benchmark evidence.
