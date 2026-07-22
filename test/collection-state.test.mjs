import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "lifedemon-collection-"));
process.env.HOUSING_DATA_DIR = dataDir;
const { db, exhaustedReviewCount, markSourceCollectionComplete, markSourceCollectionEmpty, upsertNotice, upsertNoticeWithStatus } = await import("../src/db.mjs");

function notice(id, source = "마이홈 API") {
  return {
    id, source, title: `notice ${id}`, url: `https://example.test/${id}`,
    verdict: "possible", categories: [], reasons: [], rawText: "fixture",
  };
}

test.after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("keeps prior notices active until a source collection completes successfully", () => {
  upsertNotice(notice("old-a"));
  upsertNotice(notice("old-b"));

  assert.equal(db.prepare("SELECT count(*) AS count FROM notices WHERE active=1").get().count, 2);

  const currentId = upsertNotice(notice("old-a"));
  markSourceCollectionComplete("마이홈 API", [currentId]);

  assert.deepEqual(
    db.prepare("SELECT id, active FROM notices ORDER BY id").all().map((row) => ({ ...row })),
    [
      { id: "old-a", active: 1 },
      { id: "old-b", active: 0 },
    ],
  );
});

test("does not deactivate notices from another source", () => {
  upsertNotice(notice("youth-a", "청년안심주택"));
  markSourceCollectionComplete("마이홈 API", []);

  assert.equal(db.prepare("SELECT active FROM notices WHERE id='youth-a'").get().active, 1);
});

test("does not treat a zero-result scrape as proof that all notices closed", () => {
  upsertNotice(notice("zero-safe", "HUG"));
  assert.equal(markSourceCollectionComplete("HUG", []), 0);
  assert.equal(db.prepare("SELECT active FROM notices WHERE id='zero-safe'").get().active, 1);
});

test("deactivates only the source covered by an officially confirmed empty result", () => {
  upsertNotice(notice("empty-hug", "HUG-confirmed"));
  upsertNotice(notice("keep-youth", "청년안심주택"));
  assert.equal(markSourceCollectionEmpty("HUG-confirmed"), 1);
  assert.equal(db.prepare("SELECT active FROM notices WHERE id='empty-hug'").get().active, 0);
  assert.equal(db.prepare("SELECT active FROM notices WHERE id='keep-youth'").get().active, 1);
});

test("counts active reviews that exhausted all retries", () => {
  upsertNotice(notice("failed-a"));
  db.prepare("UPDATE review_queue SET state='error', attempts=3 WHERE notice_id='failed-a'").run();

  assert.equal(exhaustedReviewCount(), 1);
});

test("classifies new, unchanged, and changed notices for collection telemetry", () => {
  const first = upsertNoticeWithStatus(notice("telemetry-a"));
  const unchanged = upsertNoticeWithStatus(notice("telemetry-a"));
  const changed = upsertNoticeWithStatus({ ...notice("telemetry-a"), rawText: "updated fixture" });

  assert.equal(first.change, "new");
  assert.equal(unchanged.change, "unchanged");
  assert.equal(changed.change, "changed");
});
