const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /(?:password|secret|api_key|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/gi,
];

export function redactSecrets(input: string): string {
  let redacted = input;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED_SECRET]');
  }
  return redacted;
}
