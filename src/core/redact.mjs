const secretPatterns = [
  [/bot\d+:[A-Za-z0-9_-]+/g, "bot[REDACTED]"],
  [/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]"],
  [/(?:sk|sess)-[A-Za-z0-9_-]{16,}/g, "[REDACTED_KEY]"],
  [/(token|api[_-]?key|service[_-]?key|secret|password)(["']?\s*[:=]\s*["']?)([^"'\s,&}]+)/gi, "$1$2[REDACTED]"],
  [/([?&](?:serviceKey|key|token|access_token|refresh_token)=)[^&\s]+/gi, "$1[REDACTED]"],
];

export function redactSecrets(value, maxLength = 8000) {
  let text = String(value || "");
  for (const [pattern, replacement] of secretPatterns) text = text.replace(pattern, replacement);
  text = text.replace(/\x1b\[[0-9;]*m/g, "").trim();
  return text.length <= maxLength ? text : `[truncated]\n${text.slice(-maxLength)}`;
}
