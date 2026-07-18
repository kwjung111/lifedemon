const googleVariable = /^(?:GOOGLE_CALENDAR_|GOOGLE_OAUTH_)[A-Z0-9_]*=/;

export function googleCalendarLinesFromEnv(value) {
  return String(value || "").split(/\r?\n/).filter((line) => googleVariable.test(line));
}

export function googleCalendarValues(value) {
  return Object.fromEntries(googleCalendarLinesFromEnv(value).map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

export function assertCompatibleCalendarId(sourceValues, targetEnv) {
  const currentId = googleCalendarValues(targetEnv).GOOGLE_CALENDAR_ID;
  const nextId = sourceValues.GOOGLE_CALENDAR_ID;
  if (currentId && nextId && currentId !== nextId) {
    throw new Error(
      "Google Calendar ID changed; migrate or clear existing reminder mappings before installing new credentials",
    );
  }
}

export function mergeGoogleCalendarEnv(existing, googleLines) {
  const kept = String(existing || "")
    .split(/\r?\n/)
    .filter((line) => !googleVariable.test(line));
  while (kept.at(-1) === "") kept.pop();

  return [
    ...kept,
    ...(kept.length ? [""] : []),
    ...googleLines,
    "",
  ].join("\n");
}
