// dsh-diff-review public type declarations.
// The runtime sources are plain JS (no annotations), so this hand-written
// declaration mirrors the stable public surface of the host entry point:
// `name`, `inject` and `apply(ctx)` as loaded by dsh. Internal helpers
// (src/host/util.ts, src/host/typert.ts) are not part of the package entry
// and are intentionally not declared here.
export const name: 'dsh-diff-review'
export const inject: string[]

/** Minimal structural view of the Cordis context handed to apply(). */
export interface DiffReviewContext {
  get(name: string): unknown
  on(event: string, listener: (...args: unknown[]) => void): () => void
  effect(fn: unknown): unknown
  interval(fn: () => void, ms: number): unknown
  [key: string]: unknown
}
export function apply(ctx: DiffReviewContext): void
