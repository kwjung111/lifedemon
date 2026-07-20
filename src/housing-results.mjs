import { runHousingResultChecks } from "./apps/housing/result-checker.mjs";

const results = await runHousingResultChecks();
console.log("housing result checks", results);
