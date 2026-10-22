export function normalizeProviderId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 32 && /^[0-9a-f]{32}$/i.test(value))
    return value.toLowerCase();
  if (
    value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    return value.replaceAll('-', '').toLowerCase();
  return null;
}
