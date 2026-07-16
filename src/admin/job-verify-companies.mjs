import { verifyActiveJobCompanies } from "../apps/jobs/verify-companies.mjs";
console.log(JSON.stringify(await verifyActiveJobCompanies(), null, 2));
