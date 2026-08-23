/* global process, console, setTimeout, window */
import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packagedExecutable = process.argv[2]
  ? resolve(process.argv[2])
  : undefined;
const userData = mkdtempSync(join(tmpdir(), "fb-account-manager-runtime-qa-"));
const errors = [];
let activeApplication;
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function launch() {
  const application = await electron.launch({
    executablePath: packagedExecutable ?? electronPath,
    args: packagedExecutable ? [] : ["."],
    cwd: process.cwd(),
    env: { ...process.env, FB_ACCOUNT_MANAGER_USER_DATA: userData },
  });
  activeApplication = application;
  const page = await application.firstWindow();
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  await page
    .getByRole("heading", { name: "Facebook Account Manager" })
    .waitFor();
  return { application, page };
}

async function open(page, label) {
  await page.getByRole("button", { name: new RegExp(label) }).click();
  await page
    .getByRole("heading", {
      name:
        label === "History"
          ? "Publish History"
          : label === "Publishing"
            ? "Publishing Operations"
            : label === "Dashboard"
              ? "Operations Dashboard"
              : label,
    })
    .waitFor();
}

try {
  const first = await launch();
  const { page } = first;
  for (const label of [
    "Dashboard",
    "Accounts",
    "Groups",
    "Drafts",
    "Queue",
    "Planner",
    "Publishing",
    "History",
    "Settings",
    "Audit Logs",
    "About",
  ])
    assert(
      (await page
        .getByRole("button", { name: new RegExp(label) })
        .count()) === 1,
      `Missing navigation: ${label}`,
    );
  const startup = await page.evaluate(() => window.publishApi.status());
  assert(
    startup.schedulerState === "DISARMED",
    "Scheduler did not start DISARMED.",
  );
  await page.evaluate(() =>
    window.settingsApi.updatePublishing({
      enabled: true,
      executionMode: "LIVE",
      schedulerIntervalSeconds: 30,
      maxConcurrentAccounts: 2,
      videoUploadTimeoutSeconds: 600,
      maxJobsPerSchedulerSession: 3,
      canaryMode: false,
      confirmLive: true,
    }),
  );
  await open(page, "Publishing");
  await page.getByRole("button", { name: "Arm Scheduler" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Arm Scheduler" })
    .click();
  await page.getByText("ARMED", { exact: true }).first().waitFor();
  await page.getByRole("button", { name: "Stop after current" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Stop after current" })
    .click();
  await page.getByText("DISARMED", { exact: true }).first().waitFor();
  await page.evaluate(() =>
    window.settingsApi.updatePublishing({
      enabled: false,
      executionMode: "DRY_RUN",
      schedulerIntervalSeconds: 30,
      maxConcurrentAccounts: 2,
      videoUploadTimeoutSeconds: 600,
      maxJobsPerSchedulerSession: 3,
      canaryMode: true,
    }),
  );
  const seeded = await page.evaluate(async () => {
    const suffix = Date.now().toString(36);
    const account = await window.accountApi.create({
      name: "QA Account",
      profileName: `qa-${suffix}`,
      proxyEnabled: false,
    });
    const group = await window.groupApi.create({
      name: "QA Group",
      url: `https://www.facebook.com/groups/qa-${suffix}`,
      tags: ["qa"],
      active: true,
    });
    await window.groupApi.replaceAssignments(group.id, [account.id]);
    const firstDraft = await window.draftApi.create({
      title: "QA Draft One",
      body: "Local runtime QA body one.",
    });
    const secondDraft = await window.draftApi.create({
      title: "QA Draft Two",
      body: "Local runtime QA body two.",
    });
    await window.draftApi.setStatus(firstDraft.id, "READY");
    await window.draftApi.setStatus(secondDraft.id, "READY");
    const base = Date.now() - 5 * 60_000;
    await window.queueApi.create({
      draftId: firstDraft.id,
      targets: [{ accountId: account.id, groupId: group.id }],
      scheduledAt: new Date(base).toISOString(),
    });
    await window.queueApi.create({
      draftId: secondDraft.id,
      targets: [{ accountId: account.id, groupId: group.id }],
      scheduledAt: new Date(base + 10 * 60_000).toISOString(),
    });
    return { accountId: account.id, groupId: group.id };
  });
  await open(page, "Dashboard");
  await page.getByText("Scheduled today", { exact: true }).waitFor();
  assert(
    (await page.evaluate(() => window.dashboardApi.summary())).today
      .scheduled === 2,
    "Dashboard counters did not use real queue data.",
  );
  await open(page, "Planner");
  await page.getByText("ACCOUNT SCHEDULE CONFLICT").first().waitFor();
  await open(page, "Queue");
  await page.getByRole("columnheader", { name: "Automation" }).waitFor();
  await page.getByRole("columnheader", { name: "Verification" }).waitFor();
  await open(page, "Groups");
  await page.getByRole("button", { name: "Assignment matrix" }).click();
  await page
    .getByRole("heading", { name: "Account assignment matrix" })
    .waitFor();
  await page.getByRole("button", { name: "Close" }).click();
  const exportPaths = { csv: join(userData, "publishing-history.csv"), json: join(userData, "operations-report.json") };
  await first.application.evaluate(({ dialog }, paths) => { let call = 0; dialog.showSaveDialog = async () => ({ canceled: false, filePath: call++ === 0 ? paths.csv : paths.json }); }, exportPaths);
  await page.evaluate(async () => { await window.operationsApi.exportHistoryCsv({}); await window.publishApi.exportReport(); });
  const csvText = readFileSync(exportPaths.csv, "utf8"); const jsonText = readFileSync(exportPaths.json, "utf8"); assert(csvText.includes("automated result") && csvText.includes("final status"), "CSV export headers are incomplete."); assert(jsonText.includes('"selectorVersion": "2026-08-v4"'), "Diagnostic JSON selector version is missing."); for (const forbidden of ["SHOULD-NOT-EXPORT", "proxy password", "session storage"]) assert(!csvText.includes(forbidden) && !jsonText.includes(forbidden), `Export leaked forbidden content: ${forbidden}`);
  const maintenance = await page.evaluate(async () => ({
    backup: await window.operationsApi.createBackup(),
    storage: await window.operationsApi.storageUsage(),
    orphan: await window.operationsApi.scanOrphanMedia(),
    about: await window.operationsApi.about(),
    accountOps: await window.accountApi.operations(),
    groupOps: await window.groupApi.operations(),
  }));
  assert(
    maintenance.backup.schemaVersion === 4,
    "Backup schema validation failed.",
  );
  assert(
    maintenance.storage.database > 0,
    "Database storage usage was not calculated.",
  );
  assert(
    maintenance.orphan.candidateCount === 0,
    "Unexpected orphan media in clean workspace.",
  );
  assert(maintenance.about.appVersion === "0.7.0", "About version mismatch.");
  assert(
    maintenance.accountOps[0].pendingQueue === 2,
    "Account queue linkage mismatch.",
  );
  assert(
    maintenance.groupOps[0].activeQueueCount === 2,
    "Group queue aggregate mismatch.",
  );
  await first.application.close();
  activeApplication = undefined;
  const second = await launch();
  const persisted = await second.page.evaluate(async () => ({
    queue: await window.queueApi.list({}),
    status: await window.publishApi.status(),
    settings: await window.settingsApi.getPublishing(),
  }));
  assert(persisted.queue.length === 2, "Queue did not persist across restart.");
  assert(
    persisted.status.schedulerState === "DISARMED",
    "Scheduler arming persisted across restart.",
  );
  assert(
    persisted.settings.maxJobsPerSchedulerSession === 3,
    "Scheduler session cap setting did not persist.",
  );
  await second.application.close();
  activeApplication = undefined;
  assert(errors.length === 0, `Renderer errors: ${errors.join(" | ")}`);
  console.log(
    JSON.stringify({
      status: "PASS",
      mode: packagedExecutable ? "PACKAGED" : "DEVELOPMENT",
      userData,
      seeded,
      checks: [
        "visible renderer",
        "preload bridge",
        "scheduler arm/stop",
        "dashboard",
        "planner",
        "queue outcomes",
        "groups matrix",
        "backup",
        "storage",
        "sanitized exports",
        "restart persistence",
      ],
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  try { await activeApplication?.close(); } catch { /* best effort */ }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* Windows may release Chromium files shortly after exit */ }
}
