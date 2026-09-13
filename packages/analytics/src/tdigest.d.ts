/**
 * No published @types/tdigest exists. Minimal ambient declaration covering
 * only the API surface CohortPercentileEngine actually uses, confirmed
 * against the package's README (push/compress/percentile/p_rank/toArray).
 */
declare module "tdigest" {
  export class TDigest {
    constructor(delta?: number, K?: number, CX?: number);
    push(x: number, n?: number): void;
    compress(): void;
    percentile(p: number | number[]): number | number[];
    p_rank(x: number | number[]): number | number[];
    toArray(everything?: boolean): Array<{ mean: number; n: number }>;
    size(): number;
  }
}
