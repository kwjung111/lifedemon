const gmailVariable = /^GMAIL_[A-Z0-9_]*=/;

export function gmailLinesFromEnv(value) {
  return String(value || "").split(/\r?\n/).filter((line) => gmailVariable.test(line));
}

export function gmailValues(value) {
  return Object.fromEntries(gmailLinesFromEnv(value).map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

export function mergeGmailEnv(existing, gmailLines) {
  const kept = String(existing || "").split(/\r?\n/).filter((line) => !gmailVariable.test(line));
  while (kept.at(-1) === "") kept.pop();
  return [...kept, ...(kept.length ? [""] : []), ...gmailLines, ""].join("\n");
}
