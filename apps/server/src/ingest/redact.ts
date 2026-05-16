const contentKeyPatterns = [
  /prompt/i,
  /completion/i,
  /messages?$/i,
  /input\.value/i,
  /output\.value/i,
  /request\.body/i,
  /response\.body/i
];

const secretPatterns = [
  /(?:sk|pk)-[a-zA-Z0-9_-]{16,}/g,
  /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b(?:postgres|postgresql|mysql|mongodb|redis|sqlserver):\/\/[^\s"'<>]+/gi
];

export function redactAttribute(key: string, value: unknown): unknown {
  if (contentKeyPatterns.some((pattern) => pattern.test(key))) {
    return contentRedaction(value);
  }
  return redactSecrets(value);
}

export function redactLogBody(value: unknown): unknown {
  return redactSecrets(value);
}

function contentRedaction(value: unknown) {
  const text = stringifyValue(value);
  return {
    redacted: true,
    reason: "content-capture-disabled",
    sha256: hashString(text),
    bytes: Buffer.byteLength(text)
  };
}

function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return secretPatterns.reduce((text, pattern) => text.replace(pattern, "[redacted]"), value);
  }
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactAttribute(key, item)]));
  }
  return value;
}

function stringifyValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
