import { db } from "../db.mjs";

console.log(db.prepare(`
  SELECT state, count(*) AS count FROM review_queue GROUP BY state ORDER BY state
`).all());
