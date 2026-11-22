/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const __wbg_journalengine_free: (a: number, b: number) => void;
export const journalengine_add_journal: (a: number, b: number, c: number) => [number, number, number];
export const journalengine_add_json: (a: number, b: number, c: number, d: number) => [number, number, number];
export const journalengine_add_text: (a: number, b: number, c: number, d: number) => number;
export const journalengine_filter: (a: number, b: any) => [number, number, number];
export const journalengine_finalize: (a: number) => void;
export const journalengine_metrics: (a: number) => [number, number, number];
export const journalengine_new: (a: number) => number;
export const journalengine_record: (a: number, b: number) => [number, number, number];
export const journalengine_records: (a: number, b: any, c: number) => [number, number, number];
export const journalengine_reset: (a: number) => void;
export const journalengine_set_metrics_enabled: (a: number, b: number) => void;
export const journalengine_summary: (a: number) => [number, number, number];
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_start: () => void;
