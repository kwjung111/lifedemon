import { db } from "../db.mjs";

for (const row of db.prepare(`
  SELECT n.source, n.title, r.eligibility, r.score, r.status, r.result_json, r.reviewed_at
  FROM notice_reviews r JOIN notices n ON n.id=r.notice_id
  ORDER BY r.reviewed_at DESC LIMIT 10
`).all()) {
  console.log(JSON.stringify({ ...row, result: JSON.parse(row.result_json), result_json: undefined }, null, 2));
}
