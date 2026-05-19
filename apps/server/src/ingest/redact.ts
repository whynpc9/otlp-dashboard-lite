const secretPatterns = [
  /(?:sk|pk)-[a-zA-Z0-9_-]{16,}/g,
  /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b(?:postgres|postgresql|mysql|mongodb|redis|sqlserver):\/\/[^\s"'<>]+/gi
];

export function redactAttribute(_key: string, value: unknown): unknown {
  return redactSecrets(value);
}

export function redactLogBody(value: unknown): unknown {
  return redactSecrets(value);
}

function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return secretPatterns.reduce((text, pattern) => text.replace(pattern, "[redacted]"), value);
  }
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecrets(item)]));
  }
  return value;
}
