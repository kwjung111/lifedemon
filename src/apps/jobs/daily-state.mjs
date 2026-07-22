export function summarizeJobsDailyRun({ collection = [], verification = { results: [] }, filtering = [], queue }) {
  const errors = [
    ...collection.filter((item) => item.error).map((item) => `${item.source}: ${item.error}`),
    ...(verification.results || []).filter((item) => item.error).map((item) => `${item.company}: ${item.error}`),
  ];
  const transientFilterErrors = filtering.filter((item) => item.error).map((item) => item.error);
  return {
    status: !errors.length && queue?.ready ? "completed" : "incomplete",
    errors: errors.slice(0, 20),
    transientFilterErrors: transientFilterErrors.slice(0, 20),
    queue,
  };
}
