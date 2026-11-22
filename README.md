# Journal Log Analyzer

A fully client-side systemd journal analyzer built with React, TypeScript, dedicated Web Workers, and an optional Rust/WebAssembly core. It accepts journal files from another machine without uploading journal contents to a server.

The production browser measurements, including unsuccessful experiments and limitations, are in [PERFORMANCE.md](PERFORMANCE.md). The final synthetic-corpus result is **1.97–2.51× median end-to-end speedup**, not the engineering target of 3×.

## Features

- Modern and legacy binary systemd journal layouts, including keyed-hash files and repeated fields.
- Plain, LZ4, ZSTD, and XZ journal objects; JSON and text log input; ZIP, TAR, TAR.GZ/TGZ, and 7z archives containing supported log files.
- Search pattern, case sensitivity, unit, kernel, minimum severity, boot, and time-range filters.
- Boot overview, lazy full-field record details, AI-analysis Markdown export, and Jira text export.
- Automatic TypeScript fallback if WASM cannot initialize or load.
- Responsive virtualized record view with numbered pagination and bidirectional lazy scrolling.
- Two hundred entries per page with at most four pages retained in the UI; downward and upward scrolling evict opposite ends of the page cache.
- Asynchronous filtering/export, with exports still containing every matching entry.
- Static hosting and offline application-shell support without requiring `SharedArrayBuffer` or cross-origin isolation.

Malformed and truncated inputs fail cleanly. Compact-mode journal files are rejected with remediation text. The existing 500,000-record limit applies to every supported archive format. Pagination bounds UI transfer and rendering memory; initial parsing still processes the complete input rather than streaming it from disk. The 7z decoder is lazy-loaded at runtime and does not require cross-origin isolation.

## Run locally

Node.js 22 is recommended. The generated WASM package is included, so Rust is not needed for an ordinary build.

```bash
npm ci
npm run dev
```

Create and serve the production build:

```bash
npm run build
npm run preview
```

## Rebuild the Rust core

Only needed after changing `core/`:

1. Install Rust with the `wasm32-unknown-unknown` target.
2. Install the CLI version matching the generated bindings (`wasm-bindgen` 0.2.130).
3. Build the core, generate bindings, and optimize the module.

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked
npm ci
npm run build:wasm
npm run build
```

`scripts/build-wasm.sh` uses `wasm-opt` from `PATH` or the installed Binaryen package. Set `CARGO_TARGET_DIR` if Cargo build scripts must execute on a different filesystem:

```bash
CARGO_TARGET_DIR=/tmp/journal-core-target npm run build:wasm
```

## Architecture

```text
File input
  └─ Dedicated module Worker
      ├─ ZIP, TAR, TAR.GZ/TGZ, and lazy-loaded 7z extraction (off the UI thread)
      ├─ Rust/WASM journal, JSON, and text parsing
      ├─ Stateful entry storage, filtering, and indexing in WASM
      ├─ Transferable Uint32Array filter results
      └─ Batched 200-entry pages / lazy detail and export records
            └─ React UI with virtualized rows and a four-page directional cache
```

The important optimization is the data path, not WASM alone:

- No JavaScript/WASM call is made per entry or per field.
- Uncompressed Rust payloads are borrowed; compressed payloads use owned buffers.
- Filtering returns one compact transferable index buffer.
- Only required 200-entry pages are materialized. Scrolling down or up requests adjacent pages and evicts the opposite cache end; direct jumps retain the closest pages. Full field maps are decoded for details and exports.
- Exports retrieve 5,000-record chunks and yield between chunks.
- ASCII literal filters use a fast path; other patterns retain ECMAScript-compatible behavior through `regress`.
- Detailed phase timers are opt-in because per-object timing materially affected throughput.
- Independent files are not dispatched to a worker pool: the measured ZIP contained one large journal, so extra parallelism had no measured justification.

The original TypeScript parser remains available as a fallback and differential-test reference. The default build needs neither COOP/COEP headers nor cross-origin isolation.

## Engine selection and profiling

Use URL query parameters:

| URL | Behavior |
| --- | --- |
| `?engine=auto` | Default: try WASM, then fall back to TypeScript with a visible warning. |
| `?engine=wasm` | Require WASM; initialization/load failures are reported instead of silently changing engines. |
| `?engine=js` | Force the TypeScript worker implementation. |
| `?engine=wasm&profile=1` | Enable detailed Rust and worker phase metrics. |

Profiling adds overhead and must not be used for the official throughput comparison. User-facing filter timing remains available without detailed profiling.

## Correctness validation

Generate the deterministic small fixtures. The Python fixture writer requires `lz4`, `zstandard`, and `py7zr`:

```bash
python3 -m pip install lz4 zstandard py7zr
npm run fixtures
```

Run all checks:

```bash
npm run build
npm run lint
npm run test:rust
npm run test:browser
npm run test:oracle
```

The browser configuration uses `/usr/bin/chromium` when available. Otherwise install Playwright Chromium or set an executable:

```bash
npx playwright install chromium
# or
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium npm run test:browser
```

The independent oracle requires `journalctl`. It copies fixtures to native temporary storage before running:

```bash
journalctl --directory <temporary-directory> -o json
```

Current validation results:

- 5 Rust unit tests passed.
- 30 production-browser tests passed, covering JS/WASM differential records, all supported archive formats, bidirectional lazy pagination, bounded cache eviction, filters, boot filtering, lazy details, exports, malformed inputs, automatic fallback, offline 7z extraction, and mobile layout.
- Plain, LZ4, ZSTD, XZ, and keyed-hash fixtures matched `journalctl -o json` for all expected fields.
- The legacy fixture is covered by JS/WASM differential tests; the installed `journalctl` does not emit that legacy fixture and therefore cannot serve as its oracle.

Fixtures include plain, LZ4, ZSTD, XZ, modern, legacy, keyed-hash, ZIP, TAR, TAR.GZ, TGZ, 7z, malformed journal/7z, truncated, compact, empty, JSON, text, large-record, and 1,000-entry pagination cases.

## Reproduce the benchmarks

The untouched original production build is included at `tests/baseline-dist`; benchmark comparisons do not depend on an external workspace path.

```bash
npm ci
npm run fixtures:benchmark
npm run build
BENCH_RUNS=5 BENCH_TARGETS=baseline,js,wasm BENCH_CORPORA=benchmark.journal,benchmark.zip BENCH_CACHES=cold,warm npm run benchmark
```

This runs 60 fresh-browser measurements and writes `tests/benchmark-results.json`. A smaller direct-journal check is:

```bash
BENCH_RUNS=1 BENCH_CORPORA=benchmark.journal BENCH_TARGETS=baseline,wasm BENCH_CACHES=cold npm run benchmark
```

Options:

- `BENCH_RUNS`: runs per configuration, default 5.
- `BENCH_CORPORA`: comma-separated fixture filenames.
- `BENCH_TARGETS`: `baseline`, `js`, and/or `wasm`.
- `BENCH_CACHES`: `cold` and/or `warm`.
- `BENCH_PROFILE=1`: opt into detailed phase timers; expect overhead.
- `BENCH_RESUME=1`: resume missing iterations from `tests/benchmark-results.json`.
- `BENCH_BASELINE_DIR`: override the included untouched baseline directory.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE`: select a Chromium executable.

Preserved evidence:

- `tests/benchmark-iteration-1.json`: untouched baseline and initial JS/WASM matrix.
- `tests/benchmark-iteration-2.json`: virtualization and literal-filter iteration.
- `tests/benchmark-iteration-3.json`: parser hot-path iteration.
- `tests/benchmark-final-wasm.json`: official final profiling-off WASM matrix.
- `tests/benchmark-profile.json`: separate opt-in diagnostic phase runs.

The supplied results use deterministic synthetic data and headless Chromium. They are not real-journal or real-device claims; rerun with the intended corpus and target hardware before generalizing them.

## Static deployment and GitHub Pages

Deploy the contents of `dist/` to any static host. Vite uses relative asset URLs, so a repository subpath such as `https://user.github.io/journal-analyzer/` works without a runtime server.

```bash
npm run build
# Publish dist/ with your GitHub Pages workflow or branch.
```

The included GitHub Actions workflow (`.github/workflows/deploy.yml`) builds the app on every pull request and deploys to Pages on pushes to `main`. It compiles the WASM engine from `core/src` in CI, installs `wasm-bindgen-cli` at the version pinned in `core/Cargo.lock`, runs the lint and Rust-test gates, and smoke-tests the deployed site (index page and WASM asset must return HTTP 200).

Use HTTPS for service-worker installation outside localhost. No application server, database, COOP, COEP, or cross-origin-isolation headers are required.

## Docker

A multi-stage `Dockerfile` builds the web app (Rust/WASM engine compiled from source, then Vite) and bundles the `journal-log-analyzer` GUI tool. The result is a build-artifact image, not a server:

```bash
docker build -t journal-analyzer --build-arg REVISION="$(git rev-parse HEAD)" .

# extract the built web app to ./dist-out:
docker run --rm -v "$PWD/dist-out:/out" journal-analyzer extract

# launch the analyzer GUI (Linux host with X11):
docker run --rm -e DISPLAY="$DISPLAY" -v /tmp/.X11-unix:/tmp/.X11-unix journal-analyzer analyze
```

Alternatively, `docker buildx build --target web --output type=local,dest=./dist-out .` writes `dist/` straight to disk without keeping an image. `docker run --rm journal-analyzer` prints the same usage.

## Offline behavior and privacy

The production service worker precaches the HTML shell, entry assets, fonts, worker, journal WASM module, and lazy-loaded 7z decoder assets. HTML uses network-first updates; immutable hashed assets use cache-first lookup. An initial online installation is required before offline reload. Offline 7z extraction is covered by a production-browser test.

Only same-origin static application assets enter Cache Storage. Uploaded journal files, parsed records, filters, details, and exports are never written to Cache Storage. Journal contents are processed locally and are not sent to an analytics service or application backend. Exports are generated as local downloads.
