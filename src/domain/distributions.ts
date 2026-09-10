/** Keep the existing bucket order and summarize the unshown tail. */
export function capDistribution<T extends { count: number }>(
  buckets: T[],
  cap: number,
): {
  shown: T[];
  other: { distinct: number; tracks: number };
} {
  const overflow = buckets.slice(cap);

  return {
    shown: buckets.slice(0, cap),
    other: {
      distinct: overflow.length,
      tracks: overflow.reduce((sum, bucket) => sum + bucket.count, 0),
    },
  };
}
