function stripWrappingQuotes(value) {
  let text = String(value || '').trim();

  while (
    text.length >= 2
    && (
      (text.startsWith('"') && text.endsWith('"'))
      || (text.startsWith("'") && text.endsWith("'"))
    )
  ) {
    text = text.slice(1, -1).trim();
  }

  return text;
}

export function canonicalizeProcessName(value) {
  let normalizedValue = stripWrappingQuotes(value).replaceAll('/', '\\');

  if (!normalizedValue) {
    return '';
  }

  if (normalizedValue.includes('\\')) {
    const segments = normalizedValue.split(/\\+/u).filter(Boolean);
    normalizedValue = segments[segments.length - 1] || '';
  }

  normalizedValue = stripWrappingQuotes(normalizedValue).toLowerCase();

  if (!normalizedValue) {
    return '';
  }

  if (!/\.[a-z0-9]+$/u.test(normalizedValue)) {
    normalizedValue += '.exe';
  }

  return normalizedValue;
}

export function normalizeProcessList(values) {
  return Array.isArray(values)
    ? Array.from(
        new Set(
          values
            .map((value) => canonicalizeProcessName(value))
            .filter(Boolean)
        )
      )
    : [];
}
