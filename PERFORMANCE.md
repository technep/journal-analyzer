# Performance report

## Result and scope

The Rust/WASM worker architecture improved median end-to-end processing by **1.97–2.51×** across the measured direct-journal and ZIP, cold and warm configurations. Filter wall time improved by **2.65–2.97×**, and no main-thread long tasks were observed during final WASM load or filter runs.

**The requested 3× end-to-end target was not reached.** These figures come from a deterministic synthetic 100,000-entry corpus in headless Chromium, not from the unspecified `<REAL_JOURNAL_CORPUS>` on `<TARGET_DEVICE_AND_BROWSER>`. They must not be presented as real-device or real-journal results.

The primary comparison is the untouched original production build against the final WASM build with detailed profiling disabled. Native-only Rust timings are not used as browser evidence.

## Method

- Date of preserved runs: 2026-11-22.
- Browser: Chromium 151.0.7922.108 through Playwright, headless, 1440×1000, UTC.
- Platform: Linux x86_64, two logical CPUs available to the environment.
- Direct input: `benchmark.journal`, 80,102,384 bytes, 100,000 entries.
- ZIP input: `benchmark.zip`, 6,389,100 bytes, containing the same journal. ZIP MB/sec uses compressed input bytes, not the uncompressed journal size.
- End-to-end latency starts at the actual file-input change event and ends at the first usable, populated view after two animation frames. It is also the reported time to first usable view.
- The measured filter is `timeout failure`, returning 20,000 of 100,000 entries. Filter wall time starts at the input event and ends after the updated view and two animation frames.
- Five fresh-browser runs per configuration. Cold runs use a new browser/context; warm runs prefetch worker/WASM assets where applicable and reload before upload.
- Median and nearest-rank p95 are reported. With only five samples, p95 is the maximum observed sample and has limited statistical confidence.
- Long tasks use the browser Long Task API (tasks over 50 ms).
- Memory is Linux browser-process-tree RSS sampled every 50 ms. Shared pages can be counted in more than one process, so this is a reproducible operational proxy rather than exact unique memory consumption.
- Official runs have `profile=1` disabled. Instrumented TypeScript and diagnostic WASM phase runs are reported separately because instrumentation changes latency.

Raw data and reproduction commands are documented in [README.md](README.md). The original production build used for `baseline` is preserved unchanged in `tests/baseline-dist`.

## End-to-end latency and throughput

| Corpus | Cache | Engine | Median ms | p95 ms | Median speedup | Entries/sec at median | Input MB/sec at median |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Journal | Cold | Original | 1,920.6 | 2,058.1 | 1.00× | 52,067 | 41.71 |
| Journal | Cold | Final WASM | **870.5** | **887.9** | **2.21×** | **114,877** | **92.02** |
| Journal | Warm | Original | 1,897.3 | 1,974.7 | 1.00× | 52,706 | 42.22 |
| Journal | Warm | Final WASM | **757.2** | **767.3** | **2.51×** | **132,066** | **105.79** |
| ZIP | Cold | Original | 2,088.9 | 2,223.4 | 1.00× | 47,872 | 3.06 |
| ZIP | Cold | Final WASM | **1,061.8** | **1,128.9** | **1.97×** | **94,180** | **6.02** |
| ZIP | Warm | Original | 2,027.5 | 2,038.0 | 1.00× | 49,322 | 3.15 |
| ZIP | Warm | Final WASM | **992.8** | **1,023.1** | **2.04×** | **100,725** | **6.44** |

Final WASM cold direct-journal runs were 879.7, 870.5, 887.9, 801.9, and 788.8 ms. The improvement is real on this corpus, but run-to-run environment effects and the small sample size remain limitations.

## Filter latency and JS/WASM boundary

All values below are medians in milliseconds. `Boundary` is worker serialization/record retrieval work; `round trip` includes the full request and conversion back to UI records. `UI residue` is the nonnegative wall-time remainder after engine filtering and round-trip time, dominated by scheduling and React rendering.

| Corpus | Cache | Original wall median / p95 | WASM wall median / p95 | Wall speedup | WASM engine | Boundary | Round trip | UI residue |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Journal | Cold | 274.3 / 278.9 | **103.4 / 103.9** | **2.65×** | 40.8 | 8.4 | 13.2 | 47.2 |
| Journal | Warm | 275.2 / 287.9 | **101.7 / 106.2** | **2.71×** | 38.6 | 8.1 | 11.3 | 51.2 |
| ZIP | Cold | 270.5 / 273.0 | **98.8 / 114.8** | **2.74×** | 32.9 | 10.8 | 17.2 | 51.8 |
| ZIP | Warm | 272.5 / 306.9 | **91.7 / 101.7** | **2.97×** | 35.4 | 6.6 | 11.1 | 47.0 |

No filter long tasks were observed in the final WASM configurations, versus median filter long-task totals of 151–195 ms in the original configurations.

## Main-thread blocking and memory

| Corpus | Cache | Peak RSS delta: original → WASM | Load long-task time: original → WASM | Load long-task count: original → WASM | Filter long-task time: original → WASM |
| --- | --- | ---: | ---: | ---: | ---: |
| Journal | Cold | 440.0 → **368.3 MiB** | 1,739 → **0 ms** | 3 → **0** | 195 → **0 ms** |
| Journal | Warm | 391.1 → **324.6 MiB** | 1,731 → **0 ms** | 3 → **0** | 189 → **0 ms** |
| ZIP | Cold | 416.9 → **413.6 MiB** | 1,673 → **0 ms** | 3 → **0** | 151 → **0 ms** |
| ZIP | Warm | 375.9 → **383.4 MiB** | 1,694 → **0 ms** | 3 → **0** | 152 → **0 ms** |

Direct-journal memory improved in this sample. ZIP memory was essentially unchanged when cold and slightly higher when warm, so no general memory-saving claim is made. The major responsiveness win is moving parsing/filtering off the UI thread and virtualizing rows, not a universal reduction in allocated storage.

## Phase breakdown

The instrumented TypeScript column is the median of five cold reference runs from iteration 1. The WASM column is a separate single diagnostic run with `profile=1`; it explains where time went and is **not** an official before/after benchmark. Fine-grained timers add overhead, especially in WASM object traversal.

| Phase (ms) | JS journal | WASM journal diagnostic | JS ZIP | WASM ZIP diagnostic |
| --- | ---: | ---: | ---: | ---: |
| File reading | 94.6 | 88.1 | 29.2 | 21.8 |
| ZIP extraction | 0.0 | 0.0 | 320.1 | 368.8 |
| Object decompression | 253.2 | 52.5 | 269.5 | 59.8 |
| Object traversal | 918.4 | 382.1 | 946.9 | 339.5 |
| UTF-8/string conversion | 662.1 | 59.9 | 659.2 | 55.3 |
| Record construction | 34.9 | 40.4 | 22.7 | 42.8 |
| JSON/text parsing | 0.0 | 0.0 | 0.0 | 0.0 |
| Sorting/indexing | 9.0 | 0.3 | 9.7 | 0.4 |
| WASM initialization | 0.0 | 27.6 | 0.0 | 28.5 |
| Worker/result boundary | 0.0 | 45.7 | 0.0 | 45.2 |
| Instrumented engine total | 1,998.0 | 904.8 | 2,302.6 | 1,169.7 |
| Instrumented end to end | 2,378.4 | 1,087.3 | 2,643.9 | 1,353.9 |

The original uninstrumented baseline does not expose internal phase timers. This is why the untouched baseline supplies the official latency numbers while the instrumented TypeScript reference supplies only the baseline phase attribution.

Object traversal, UTF-8/string conversion, record allocation, ZIP extraction, and the worker/render boundary remain more important than sorting. Native Rust measurements would not capture the browser boundary or React costs and were not substituted for these results.

## Optimization iterations, including neutral and failed approaches

1. **Initial Rust/WASM worker:** Direct-journal cold median was about 1,227 ms versus the original 1,921 ms (about 1.57×); ZIP was about 1,502 ms versus 2,089 ms (about 1.39×). Initial direct-journal main-thread load long-task time dropped from roughly 1.74 s to 0.18 s. This falsified the assumption that merely compiling parsing to WASM was enough for 3×.
2. **Data architecture and rendering:** Batched stateful storage, transferable indices, lazy details, chunked exports, and virtualization reduced DOM/render cost. Rendering 2,000 nonvirtualized rows had added roughly 300 ms. Literal filtering brought filter wall time into the roughly 100–120 ms range.
3. **Generic regex experiment:** `regress` preserved ECMAScript behavior but was slower than JavaScript for the measured literal pattern. ASCII literal matching was added, while non-ASCII ignore-case and general regexes retain the compatible fallback.
4. **Rust hot paths:** Borrowing uncompressed payloads with `Cow<[u8]>`, replacing per-field regex validation with manual checks, and changing worker-filter scheduling were neutral to modest within run variance. No standalone speedup is claimed for them.
5. **Profiling overhead:** Detailed per-object timing materially hurt throughput. It became opt-in; user-facing filter timing remained. The final 870.5 ms direct cold median is from profiling-off runs.
6. **TypeScript worker fallback:** Instrumentation and the new data path made the measured TypeScript fallback slower end to end than the untouched original (for example, 2,287.6 ms direct cold versus 1,920.6 ms), despite much better filter wall time. It is retained for compatibility and differential testing, not claimed as the fastest load path.
7. **WASM size optimization:** `wasm-opt -Oz` reduced the initial module only modestly, from roughly 1.826 MB to 1.729 MB. It was not a transformative performance fix.
8. **Worker parallelism:** A multi-file worker pool was not added. The principal ZIP benchmark held one large journal, so parallel independent-file parsing had no evidence to justify its complexity.
9. **Indiscriminate porting:** ZSTD was already WASM-backed in the original TypeScript path. Repeating that port without addressing copies, traversal, object creation, and rendering would have wasted effort.

## Bundle cost

Current production key assets, using decimal kB:

| Asset | Original raw / gzip | Final raw / gzip |
| --- | ---: | ---: |
| Main JavaScript | 417.7 / 140.1 kB | 426.6 / 143.0 kB |
| Worker JavaScript | — | 110.9 / 35.0 kB |
| Rust WASM | — | 1,732.2 / 645.9 kB |
| CSS | 126.3 / 36.0 kB | 126.4 / 36.1 kB |

The WASM module is a substantial download and parse cost, especially on slower networks/devices. Static hosts should serve `.wasm` as `application/wasm` and enable gzip or Brotli. Warm results show useful caching benefits, but they do not eliminate the deployment-size tradeoff.

## Correctness results

Final validation passed:

- Production TypeScript/Vite build and ESLint.
- 5 Rust unit tests.
- 22 production-browser tests, including full normalized JS/WASM snapshots, filters, boot selection, lazy details, both exports, malformed/truncated/compact failures, automatic fallback, offline reload with cached worker/WASM, and mobile layout.
- 5 independent `journalctl -o json` fixture comparisons: plain, LZ4, ZSTD, XZ, and keyed-hash, each with three records matching all expected fields.

Coverage includes modern and legacy layouts, repeated fields, JSON, text, ZIP, empty input, and large records. The installed `journalctl` cannot emit the legacy fixture, so legacy coverage is differential against the original TypeScript parser rather than independently verified by that oracle.

## Remaining bottlenecks and required next measurement

- JSZip extraction remains a significant ZIP cost.
- Rust object traversal, record/field construction, and string allocation remain substantial.
- General non-literal regex filtering still depends on `regress`.
- Worker serialization and React/render scheduling account for a visible share of filter wall time.
- The 1.73 MB raw WASM module affects cold startup and deployment size.
- Five runs per cell and a two-CPU headless environment limit generalization; more runs and real hardware are needed for robust tail-latency claims.

The next valid performance gate is to run this same harness with the intended real journal corpus on the intended device/browser, retaining the untouched baseline and reporting cold/warm medians, p95, memory, long tasks, correctness, and failed experiments. Until then, 3× remains an unverified engineering target rather than an achieved result.
