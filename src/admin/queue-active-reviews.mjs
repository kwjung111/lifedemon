import { queueActiveForReview } from "../db.mjs";

console.log(`queued ${queueActiveForReview()} active notices`);
