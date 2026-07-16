import { db, listHousingRules } from "./db.mjs";

console.log("rules", listHousingRules().map(({ id, kind, keyword, instruction, enabled }) => ({
  id, kind, keyword, instruction, enabled,
})));
console.log("matching active notices", db.prepare(`
  SELECT source, verdict, title
  FROM notices
  WHERE active=1 AND (title LIKE '%민간임대%' OR raw_text LIKE '%민간임대%')
  ORDER BY source, title
  LIMIT 50
`).all());
console.log("report candidates", db.prepare(`
  SELECT source, verdict, apply_start, apply_end, title, substr(raw_text, 1, 1200) AS raw_sample
  FROM notices
  WHERE active=1 AND verdict IN ('likely', 'possible')
  ORDER BY CASE verdict WHEN 'likely' THEN 0 ELSE 1 END, source, title
  LIMIT 80
`).all());
console.log("youth purchase rental matches", db.prepare(`
  SELECT id, source, active, verdict, published_at, apply_start, apply_end,
         announcement_date, title, url
  FROM notices
  WHERE title LIKE '%2026%1차%청년%매입임대%'
  ORDER BY last_seen DESC
`).all());
