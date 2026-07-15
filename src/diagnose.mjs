import { db } from "./db.mjs";

console.log("COUNTS");
for (const row of db.prepare(`
  SELECT source, verdict, active, COUNT(*) AS count
  FROM notices GROUP BY source, verdict, active ORDER BY source, verdict
`).all()) console.log(row);

console.log("\nACTIVE CANDIDATES");
for (const row of db.prepare(`
  SELECT source, verdict, title, apply_end FROM notices
  WHERE active=1 AND verdict != 'exclude'
  ORDER BY source, verdict, title
`).all()) console.log(row);
