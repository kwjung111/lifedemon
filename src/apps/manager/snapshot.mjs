import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  appliedNotices,
  getSetting,
  housingOutcomeFeedback,
  listHousingRules,
  recentApplicationResults,
} from "../../db.mjs";
import { loadHousingProfile } from "../housing/profile.mjs";
import {
  appliedJobs,
  getJobSetting,
  jobAssessmentSummary,
} from "../jobs/db.mjs";
import {
  companyVerificationFingerprint,
  loadAuthorizedCompanyVerifications,
} from "../jobs/company-verification.mjs";
import { jobProfileFingerprint, loadJobProfile } from "../jobs/profile.mjs";
import {
  getPlatformSetting,
  listFeedbackRules,
  listReminders,
  recentFeedbackEvents,
  telegramOutboxHealth,
} from "../../core/state.mjs";
import { calendarSyncStatus } from "../../integrations/google-calendar.mjs";

const packageJson = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));

export const managedUnits = [
  "monitor-telegram-bot.service",
  "monitor-reminder.service",
  "monitor-telegram-outbox.service",
  "housing-daily.timer",
  "housing-result-check.timer",
  "jobs-daily.timer",
];

export function parseSystemctlShow(text) {
  return Object.fromEntries(String(text || "").split(/\r?\n/).flatMap((line) => {
    const index = line.indexOf("=");
    return index < 1 ? [] : [[line.slice(0, index), line.slice(index + 1) || null]];
  }));
}

function defaultSystemctl(unit) {
  if (process.platform !== "linux") throw new Error("systemd is available only on the production Linux host");
  return execFileSync("/usr/bin/systemctl", [
    "show", unit,
    "--property=Id,Description,LoadState,ActiveState,SubState,Result,ActiveEnterTimestamp,InactiveEnterTimestamp,NextElapseUSecRealtime,LastTriggerUSec",
    "--no-pager",
  ], { encoding: "utf8", timeout: 3000, windowsHide: true });
}

function safeSection(load) {
  try {
    return { available: true, ...load() };
  } catch (error) {
    return { available: false, error: String(error?.message || error).slice(0, 500) };
  }
}

function serviceSnapshot(systemctl) {
  return managedUnits.map((unit) => {
    try {
      return { unit, available: true, ...parseSystemctlShow(systemctl(unit)) };
    } catch (error) {
      return { unit, available: false, error: String(error?.message || error).slice(0, 300) };
    }
  });
}

function housingSnapshot() {
  return safeSection(() => ({
    profile: loadHousingProfile(),
    rules: listHousingRules().map(({ kind, keyword, instruction }) => ({ kind, keyword, instruction })),
    recommendationFeedback: housingOutcomeFeedback(5),
    collection: {
      lastAttemptAt: getSetting("housing_collection_last_attempt_at"),
      lastSuccessAt: getSetting("housing_collection_last_success_at"),
    },
    applications: appliedNotices().slice(0, 10).map((notice) => ({
      source: notice.source,
      title: notice.title,
      appliedAt: notice.applied_at,
      announcementDate: notice.effective_announcement_date,
    })),
    recentResults: recentApplicationResults(5).map((result) => ({
      title: result.title,
      housingName: result.housing_name,
      stage: result.stage,
      outcome: result.outcome,
      cutoffPriority: result.cutoff_priority,
      cutoffScore: result.cutoff_score,
      supplyUnits: result.supply_units,
      reachedPriority: result.reached_priority,
      updatedAt: result.updated_at,
    })),
  }));
}

function jobsSnapshot() {
  return safeSection(() => {
    const profile = loadJobProfile();
    const verifications = loadAuthorizedCompanyVerifications();
    const assessments = jobAssessmentSummary(
      jobProfileFingerprint(profile),
      companyVerificationFingerprint(verifications),
      10,
      {
        excludedCompanies: listFeedbackRules("jobs", "exclude_company").map((rule) => rule.keyword),
        preferredCompanies: recentFeedbackEvents(100)
          .filter((event) => event.domain === "jobs" && event.signal === "positive" && event.subject_type === "company")
          .map((event) => event.subject_value),
      },
    );
    return {
      profile,
      collection: {
        lastAttemptAt: getJobSetting("job_collection_last_attempt_at"),
        lastSuccessAt: getJobSetting("job_collection_last_success_at"),
      },
      assessmentCounts: assessments.counts,
      recommended: assessments.selected.slice(0, 10).map((job) => ({
        company: job.company,
        title: job.title,
        source: job.source,
        decision: job.decision,
        assessedAt: job.assessed_at,
      })),
      filterFailures: assessments.failures,
      applications: appliedJobs().slice(0, 10).map((job) => ({
        company: job.company,
        title: job.title,
        appliedAt: job.applied_at,
      })),
      verifiedCompanyCount: verifications.size,
    };
  });
}

function remindersSnapshot() {
  return safeSection(() => {
    const calendar = calendarSyncStatus();
    return {
      calendar: {
        enabled: calendar.enabled,
        configured: calendar.configured,
        lastSync: calendar.lastSync,
        lastError: calendar.lastError,
      },
      reminders: listReminders().slice(0, 20).map((reminder) => ({
        title: reminder.title,
        dueAt: reminder.due_at,
        status: reminder.status,
        module: reminder.module,
        calendarSyncedAt: reminder.calendar_synced_at,
        calendarSyncError: reminder.calendar_sync_error,
      })),
      calendarLastSync: getPlatformSetting("google_calendar_last_sync"),
      calendarLastError: getPlatformSetting("google_calendar_last_error"),
    };
  });
}

export function buildSystemSnapshot({ now = new Date(), systemctl = defaultSystemctl } = {}) {
  return {
    generatedAt: now.toISOString(),
    timezone: "Asia/Seoul",
    version: packageJson.version,
    housing: housingSnapshot(),
    jobs: jobsSnapshot(),
    reminders: remindersSnapshot(),
    feedback: {
      activeRules: listFeedbackRules().map(({ domain, kind, keyword, instruction }) => ({ domain, kind, keyword, instruction })),
      recent: recentFeedbackEvents(10).map(({ domain, entity_id, signal, subject_type, subject_value, created_at }) => ({
        domain, entityId: entity_id, signal, subjectType: subject_type, subjectValue: subject_value, createdAt: created_at,
      })),
    },
    telegramOutbox: telegramOutboxHealth(),
    services: serviceSnapshot(systemctl),
  };
}
