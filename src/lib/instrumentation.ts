export type JsPhase =
  | 'fileReadMs'
  | 'zipExtractionMs'
  | 'decompressionMs'
  | 'objectTraversalMs'
  | 'stringConversionMs'
  | 'recordConstructionMs'
  | 'jsonParseMs'
  | 'textParseMs'
  | 'sortIndexMs'
  | 'boundaryMs'

export type JsMetrics = Record<JsPhase, number> & { inputBytes: number }

const zeroMetrics = (): JsMetrics => ({
  fileReadMs: 0,
  zipExtractionMs: 0,
  decompressionMs: 0,
  objectTraversalMs: 0,
  stringConversionMs: 0,
  recordConstructionMs: 0,
  jsonParseMs: 0,
  textParseMs: 0,
  sortIndexMs: 0,
  boundaryMs: 0,
  inputBytes: 0,
})

let active: JsMetrics | null = null

export function beginJsMetrics() {
  active = zeroMetrics()
}

export function phaseStart(): number {
  return active ? performance.now() : 0
}

export function phaseEnd(phase: JsPhase, started: number) {
  if (active) active[phase] += performance.now() - started
}

export function phaseAdd(phase: JsPhase, elapsed: number) {
  if (active) active[phase] += elapsed
}

export function addInputBytes(bytes: number) {
  if (active) active.inputBytes += bytes
}

export function startObjectTraversal(): [number, number, number] {
  return active ? [performance.now(), active.decompressionMs, active.stringConversionMs] : [0, 0, 0]
}

export function endObjectTraversal(snapshot: [number, number, number]) {
  if (!active) return
  const [started, decompression, strings] = snapshot
  const nested = active.decompressionMs - decompression + active.stringConversionMs - strings
  active.objectTraversalMs += Math.max(0, performance.now() - started - nested)
}

export function finishJsMetrics(): JsMetrics {
  const result = active ?? zeroMetrics()
  active = null
  return result
}
