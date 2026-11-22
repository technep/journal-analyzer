/* tslint:disable */
/* eslint-disable */

export class JournalEngine {
    free(): void;
    [Symbol.dispose](): void;
    add_journal(bytes: Uint8Array | number[]): number;
    add_json(bytes: Uint8Array | number[], default_year: number): number;
    add_text(bytes: Uint8Array | number[], default_year: number): number;
    filter(filters: any): any;
    finalize(): void;
    metrics(): any;
    constructor(max_records: number);
    record(index: number): any;
    records(indices: Uint32Array, include_fields: boolean): any;
    reset(): void;
    set_metrics_enabled(enabled: boolean): void;
    summary(): any;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_journalengine_free: (a: number, b: number) => void;
    readonly journalengine_add_journal: (a: number, b: number, c: number) => [number, number, number];
    readonly journalengine_add_json: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly journalengine_add_text: (a: number, b: number, c: number, d: number) => number;
    readonly journalengine_filter: (a: number, b: any) => [number, number, number];
    readonly journalengine_finalize: (a: number) => void;
    readonly journalengine_metrics: (a: number) => [number, number, number];
    readonly journalengine_new: (a: number) => number;
    readonly journalengine_record: (a: number, b: number) => [number, number, number];
    readonly journalengine_records: (a: number, b: any, c: number) => [number, number, number];
    readonly journalengine_reset: (a: number) => void;
    readonly journalengine_set_metrics_enabled: (a: number, b: number) => void;
    readonly journalengine_summary: (a: number) => [number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
