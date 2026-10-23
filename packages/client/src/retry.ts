export function retryDelay(ceilingMs: number, minimumMs = 0): number {
  if (
    !Number.isSafeInteger(ceilingMs) ||
    ceilingMs < 1 ||
    ceilingMs > 60_000 ||
    !Number.isFinite(minimumMs) ||
    minimumMs < 0 ||
    minimumMs > 300_000
  )
    throw new RangeError('Retry delay inputs exceed the supported bounds.');
  const half = Math.ceil(ceilingMs / 2);
  return (
    Math.max(half, Math.ceil(minimumMs)) +
    Math.floor(Math.random() * (ceilingMs - half + 1))
  );
}
