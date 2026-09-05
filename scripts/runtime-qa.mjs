/* global process, console, setTimeout, window, document */
import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { Buffer } from "node:buffer";

const packagedExecutable = process.argv[2]
  ? resolve(process.argv[2])
  : undefined;
const userData = mkdtempSync(join(tmpdir(), "fb-account-manager-runtime-qa-"));
const errors = [];
let activeApplication;
let proxyServer;
let proxyPort;
let browserServer;
let browserPort;
let browserFixtureMode = "READY";
const proxyFixtureEvents = [];
const proxyUsername = "qa-provider-user";
const proxyPassword = "qa-fixture-password";
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function launch() {
  const application = await electron.launch({
    executablePath: packagedExecutable ?? electronPath,
    args: packagedExecutable ? [] : ["."],
    cwd: process.cwd(),
    env: { ...process.env, FB_ACCOUNT_MANAGER_USER_DATA: userData, FB_PROXY_TEST_ENDPOINTS: `http://proxy-test.invalid/ip`, FB_BROWSER_HOME_URL: `http://127.0.0.1:${browserPort}/facebook`, FB_ACCOUNT_SESSION_QA_TIME_SCALE: "120" },
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

async function startProxyFixture() {
  const expected = `Basic ${Buffer.from(`${proxyUsername}:${proxyPassword}`).toString("base64")}`;
  proxyServer = createServer((request, response) => {
    proxyFixtureEvents.push(`${request.method} ${request.url}`);
    if (request.headers["proxy-authorization"] !== expected) { response.writeHead(407, { "Proxy-Authenticate": 'Basic realm="runtime-qa"' }); response.end("Proxy authentication required"); return; }
    response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"ip":"203.0.113.77"}');
  });
  proxyServer.on("connect", (request, socket) => {
    proxyFixtureEvents.push(`CONNECT ${request.url}`);
    if (request.headers["proxy-authorization"] !== expected) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="runtime-qa"\r\n\r\n'); return; }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", () => { const body = '{"ip":"203.0.113.77"}'; socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`); });
  });
  await new Promise((resolveListen, rejectListen) => { proxyServer.once("error", rejectListen); proxyServer.listen(0, "0.0.0.0", resolveListen); });
  proxyPort = proxyServer.address().port;
}

async function startBrowserFixture() {
  browserServer = createServer((_request, response) => { const body = browserFixtureMode === "CHECKPOINT" ? '<html><body>Checkpoint security verification. Manual user action required.</body></html>' : '<html><body><nav role="navigation">Home Notifications</nav><main>Local Facebook readiness fixture</main></body></html>'; response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(body); });
  await new Promise((resolveListen, rejectListen) => { browserServer.once("error", rejectListen); browserServer.listen(0, "127.0.0.1", resolveListen); }); browserPort = browserServer.address().port;
}

async function open(page, label) {
  await page.locator(".side-nav").getByRole("button", { name: new RegExp(label) }).click();
  await page
    .getByRole("heading", {
      name:
        label === "History"
          ? "Publish History"
          : label === "Publishing"
            ? "Publishing Operations"
            : label === "Dashboard"
              ? "Operations Dashboard"
              : label === "Account Onboarding"
                ? "Account Session Assistant"
              : label,
    })
    .waitFor();
}

try {
  await startProxyFixture();
  await startBrowserFixture();
  const first = await launch();
  const { page } = first;
  for (const label of [
    "Dashboard",
    "Accounts",
    "Account Onboarding",
    "Groups",
    "Drafts",
    "Campaigns",
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
        .locator(".side-nav")
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
      batchPacingSeconds: 10,
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
      batchPacingSeconds: 10,
      canaryMode: true,
      requireReadyAccounts: true,
    }),
  );
  await open(page, "Accounts");
  await page.getByRole("button", { name: "Import proxies" }).click();
  await page.locator("textarea.import-text").fill(`127.0.0.1:${proxyPort}\ninvalid proxy`);
  await page.getByRole("button", { name: "Preview" }).click();
  await page.locator(".import-row.invalid").waitFor();
  assert((await page.getByText("Invalid proxy input", { exact: true }).count()) === 1, "Proxy import preview did not report the invalid row.");
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: /Add account/ }).click();
  await page.getByLabel("Account name").fill("QA Proxy Account");
  await page.getByLabel("Profile name").fill(`qa-proxy-${Date.now().toString(36)}`);
  await page.getByLabel("Fixed proxy").check();
  await page.getByLabel("Paste proxy").fill(`http://${proxyUsername}:${proxyPassword}@127.0.0.1:${proxyPort}`);
  await page.getByRole("button", { name: "Paste proxy" }).click();
  assert(await page.getByLabel("Host").inputValue() === "127.0.0.1", "Pasted proxy host was not populated.");
  assert(await page.getByLabel("Protocol").inputValue() === "HTTP", "Pasted proxy protocol was not populated.");
  await page.getByRole("button", { name: "Test proxy" }).click();
  await page.locator(".proxy-test-result, .inline-error").waitFor();
  assert((await page.locator(".form-modal").innerText()).includes("Proxy connected"), `Proxy success fixture failed (${proxyFixtureEvents.join(" | ")}): ${await page.locator(".form-modal").innerText()}`);
  await page.getByText("IP: 203.0.113.77", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Create account" }).click();
  const proxyRow = page.locator(".table-card").getByRole("row").filter({ hasText: "QA Proxy Account" });
  await proxyRow.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: /^(Re)?Test proxy$/i }).click();
  await page.locator(".proxy-test-result, .inline-error").waitFor();
  assert((await page.locator(".form-modal").innerText()).includes("Proxy authentication failed."), `Proxy auth fixture failed: ${await page.locator(".form-modal").innerText()}`);
  await page.getByLabel("Password").fill("");
  await page.getByLabel("Host").fill("127.0.0.2");
  await page.getByRole("button", { name: "Save changes" }).click();
  await proxyRow.getByRole("button", { name: "Edit" }).click();
  await page.getByText("Password: Saved", { exact: true }).waitFor();
  await page.getByRole("button", { name: /^(Re)?Test proxy$/i }).click();
  await page.locator(".proxy-test-result, .inline-error").waitFor();
  assert((await page.locator(".form-modal").innerText()).includes("Proxy connected"), `Saved proxy retest failed: ${await page.locator(".form-modal").innerText()}`);
  await page.getByRole("button", { name: "Cancel" }).click();
  await proxyRow.getByText("WORKING", { exact: true }).waitFor();
  await proxyRow.getByText("IP 203.0.113.77", { exact: true }).waitFor();
  const seeded = await page.evaluate(async () => {
    const suffix = Date.now().toString(36);
    const account = await window.accountApi.create({
      name: "QA Account",
      profileName: `qa-${suffix}`,
      proxyEnabled: false,
    });
    const checkpointAccount = await window.accountApi.create({ name: "QA Checkpoint Account", profileName: `qa-checkpoint-${suffix}`, proxyEnabled: false });
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
    return { accountId: account.id, checkpointAccountId: checkpointAccount.id, groupId: group.id };
  });
  const canaryBatchError = await page.evaluate(async () => {
    const queue = await window.queueApi.list({});
    await window.settingsApi.updatePublishing({ enabled: true, executionMode: "LIVE", schedulerIntervalSeconds: 30, maxConcurrentAccounts: 2, videoUploadTimeoutSeconds: 600, maxJobsPerSchedulerSession: 3, batchPacingSeconds: 10, canaryMode: true, confirmLive: true });
    try { await window.publishApi.runSelected(queue.slice(0, 2).map((item) => item.id)); return "NO_ERROR"; }
    catch (error) { return { code: error?.code, message: error instanceof Error ? error.message : String(error) }; }
  });
  assert(canaryBatchError.message.includes("Canary mode allows one queue item"), `Canary batch guard failed: ${JSON.stringify(canaryBatchError)}`);
  await page.evaluate(() => window.settingsApi.updatePublishing({ enabled: false, executionMode: "DRY_RUN", schedulerIntervalSeconds: 30, maxConcurrentAccounts: 2, videoUploadTimeoutSeconds: 600, maxJobsPerSchedulerSession: 3, batchPacingSeconds: 10, canaryMode: true, requireReadyAccounts: true }));
  await open(page, "Account Onboarding");
  await page.locator(".onboarding-account").filter({ hasText: "QA Account" }).click();
  await page.getByRole("button", { name: "Start onboarding" }).click();
  await page.waitForTimeout(500);
  assert((await page.locator(".onboarding-detail").innerText()).includes("WARMING"), `Onboarding did not start: ${await page.locator("body").innerText()}`);
  await page.getByLabel("Daily target").selectOption("10");
  await page.getByRole("button", { name: "Start Session", exact: true }).click();
  try {
    await page.waitForFunction(() => document.body.innerText.includes("ACTIVE") || Boolean(document.querySelector(".notice.error")), undefined, { timeout: 60_000 });
  } catch (error) {
    const state = await page.evaluate(async (accountId) => ({ account: await window.accountApi.list().then((accounts) => accounts.find((account) => account.id === accountId)), body: document.body.innerText }), seeded.accountId);
    throw new Error(`Account session wait failed: ${error instanceof Error ? error.message : String(error)}\nAccount: ${JSON.stringify(state.account)}\nUI: ${state.body}`);
  }
  assert((await page.locator("body").innerText()).includes("ACTIVE"), `Account session did not start: ${await page.locator("body").innerText()}`);
  await page.waitForTimeout(1200);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "End Session", exact: true }).click();
  await page.getByRole("button", { name: "Start Session", exact: true }).waitFor();
  await page.getByRole("button", { name: "Close Browser", exact: true }).click();
  await page.getByRole("button", { name: "Start Session", exact: true }).click();
  await page.getByText("ACTIVE", { exact: true }).first().waitFor();
  const accumulatedProgress = (await page.locator(".session-card-heading strong").innerText()).trim();
  assert(/^((?!00:00).)+ \/ 10:00$/.test(accumulatedProgress), `Second same-day session did not show accumulated progress: ${accumulatedProgress}`);
  await page.getByRole("button", { name: "Pause Timer", exact: true }).click();
  await page.getByText("PAUSED", { exact: true }).first().waitFor();
  await page.getByRole("button", { name: "Open Notifications", exact: true }).click();
  await page.getByText("Page opened in the existing persistent profile.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Resume Timer", exact: true }).click();
  await page.getByText("ACTIVE", { exact: true }).first().waitFor();
  await page.getByText("✓ TARGET COMPLETE", { exact: true }).waitFor({ timeout: 20_000 });
  const targetCompleted = await page.evaluate((accountId) => window.onboardingApi.sessionDetail(accountId), seeded.accountId);
  assert(targetCompleted.sessions.length === 2 && targetCompleted.sessions[0].status === "COMPLETED" && targetCompleted.sessions[0].completionReason === "TARGET_REACHED" && targetCompleted.sessions[1].completionReason === "OPERATOR_ENDED" && targetCompleted.dailyProgress[0].completed, "Main-process multi-session target completion failed.");
  assert(targetCompleted.account.status === "RUNNING", "Browser should remain open after target completion by default.");
  await page.getByRole("button", { name: "Close Browser", exact: true }).click();
  assert((await page.evaluate((accountId) => window.onboardingApi.sessionDetail(accountId), seeded.accountId)).sessions[0].completionReason === "TARGET_REACHED", "Browser close rewrote completed session history.");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Mark READY" }).click();
  await page.getByText("READY", { exact: true }).first().waitFor();
  await page.evaluate((accountId) => window.onboardingApi.start({ accountId, templateId: "BASIC_3_DAY" }), seeded.checkpointAccountId);
  await page.locator(".onboarding-account").filter({ hasText: "QA Checkpoint Account" }).click();
  await page.getByRole("button", { name: "Start Session", exact: true }).waitFor();
  await page.getByRole("button", { name: "Start Session", exact: true }).click();
  await page.getByText("ACTIVE", { exact: true }).first().waitFor({ timeout: 60_000 });
  browserFixtureMode = "CHECKPOINT";
  await page.getByRole("button", { name: "Health Check", exact: true }).click();
  await page.getByText("PAUSED", { exact: true }).first().waitFor();
  assert((await page.evaluate((accountId) => window.onboardingApi.sessionDetail(accountId), seeded.checkpointAccountId)).sessions[0].completionReason === "HEALTH_INTERRUPTED", "Checkpoint did not interrupt the account session before target.");
  browserFixtureMode = "READY";
  await page.getByRole("button", { name: "Health Check", exact: true }).click();
  await page.getByText("Health check: READY", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Resume onboarding" }).click();
  await page.waitForTimeout(500);
  assert((await page.locator(".onboarding-detail").innerText()).includes("WARMING"), `Onboarding did not resume: ${await page.locator("body").innerText()}`);
  await page.getByRole("button", { name: "Close Browser", exact: true }).click();
  const onboardingRuntime = await page.evaluate(async (accountId) => ({ onboarding: await window.onboardingApi.get(accountId), sessions: await window.onboardingApi.sessionDetail(accountId) }), seeded.accountId);
  assert(onboardingRuntime.onboarding.account.onboardingStatus === "READY" && onboardingRuntime.sessions.sessions.length === 2 && onboardingRuntime.sessions.sessions[0].completionReason === "TARGET_REACHED", "Account target session lifecycle failed.");
  await open(page, "Dashboard");
  await page.getByText("Scheduled today", { exact: true }).waitFor();
  assert(
    (await page.evaluate(() => window.dashboardApi.summary())).today
      .scheduled === 2,
    "Dashboard counters did not use real queue data.",
  );
  assert((await page.evaluate(() => window.dashboardApi.summary())).onboarding.ready === 1, "Dashboard onboarding counters did not update.");
  const sessionDashboard = await page.evaluate(() => window.dashboardApi.summary()); assert(sessionDashboard.accountSessions.sessionsToday === 3 && sessionDashboard.accountSessions.dailyTargetsCompleted === 1 && sessionDashboard.accountSessions.activeNow === 0, "Dashboard account-session counters did not update deterministically.");
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

  // Campaign Workspace V1 end-to-end verification (Steps 1-17)
  // Step 3: create Draft
  const campaignDraft = await page.evaluate(async () => {
    return window.draftApi.create({
      title: "QA Campaign Draft",
      body: "Campaign planning promotion body text.",
    });
  });
  // Step 4: make Draft READY
  await page.evaluate(async (id) => {
    return window.draftApi.setStatus(id, "READY");
  }, campaignDraft.id);

  // Navigate to Campaigns
  await open(page, "Campaigns");

  // Step 5: create Campaign
  await page.getByRole("button", { name: /New Campaign/i }).click();
  await page.locator(".modal-card input").fill("Summer Launch Campaign");
  await page.locator(".modal-card").getByRole("button", { name: /Create Campaign/i }).click();
  await page.getByText("Summer Launch Campaign").first().waitFor();

  // Step 6: attach Draft as Variant A
  await page.getByRole("button", { name: /Add Variant/i }).click();
  await page.locator(".modal-card select").selectOption(campaignDraft.id);
  await page.locator(".modal-card input").fill("Variant A");
  await page.locator(".modal-card").getByRole("button", { name: /Add Variant/i }).click();
  await page.getByText("Variant A").first().waitFor();

  // Step 7: seeded.accountId and seeded.groupId already have valid assignment fixture
  // Step 8: add plan item
  await page.getByRole("button", { name: /Add Target/i }).click();
  await page.locator(".modal-card select").nth(1).selectOption(seeded.accountId);
  await page.locator(".modal-card select").nth(2).selectOption(seeded.groupId);
  await page.locator(".modal-card input[type='datetime-local']").fill("2026-09-30T10:00");
  await page.locator(".modal-card").getByRole("button", { name: /Add Target/i }).click();
  await page.getByText("QA Group").first().waitFor();

  // Step 9: request review
  await page.getByRole("button", { name: /Request Review/i }).click();
  await page.getByText("IN_REVIEW", { exact: true }).first().waitFor();

  // Step 10: approve campaign
  await page.getByRole("button", { name: /Approve Campaign/i }).click();
  await page.getByText("APPROVED", { exact: true }).first().waitFor();

  // Acceptance Hardening Stale-Approved Recovery Cycle:
  // 1. Modify the referenced Draft after approval
  await page.evaluate(async (id) => {
    return window.draftApi.update(id, {
      title: "QA Campaign Draft",
      body: "Modified body text after approval to trigger stale check.",
    });
  }, campaignDraft.id);

  // 2. Reload campaign in UI
  await page.getByText("Summer Launch Campaign").first().click();
  await page.getByText("Approval Stale").first().waitFor();

  // 3. Simulate to verify APPROVAL_STALE blocker
  await page.getByRole("button", { name: /Simulate Campaign/i }).click();
  await page.locator(".simulation-stat-pill").filter({ hasText: "BLOCKED" }).waitFor();

  // 4. Explicitly Reopen for Changes
  await page.getByRole("button", { name: /Reopen for Changes/i }).first().click();
  await page.getByText("DRAFT", { exact: true }).first().waitFor();

  // 4. Review and approve again
  await page.getByRole("button", { name: /Request Review/i }).click();
  await page.getByText("IN_REVIEW", { exact: true }).first().waitFor();
  await page.getByRole("button", { name: /Approve Campaign/i }).click();
  await page.getByText("APPROVED", { exact: true }).first().waitFor();

  // Step 11: simulate campaign
  await page.getByRole("button", { name: /Simulate Campaign/i }).click();

  // Step 12: verify simulation preview
  await page.locator(".simulation-stat-pill").filter({ hasText: "READY" }).waitFor();
  await page.getByText("Planned Queue Rows Preview:").waitFor();

  // Step 13: verify Queue still unchanged before commit
  const queueBeforeCommit = await page.evaluate(() => window.queueApi.list({}));
  assert(queueBeforeCommit.length === 2, "Queue was unexpectedly modified before commit.");

  // Step 14: commit to Queue
  await page.getByRole("button", { name: /Commit to Queue/i }).click();
  await page.locator(".modal-card").getByRole("button", { name: /Confirm & Commit/i }).click();
  await page.getByText("QUEUED", { exact: true }).first().waitFor();

  // Step 15: verify Queue row appears
  const queueAfterCommit = await page.evaluate(() => window.queueApi.list({}));
  assert(queueAfterCommit.length === 3, "Queue row was not created on commit.");
  const committedCampaignItem = queueAfterCommit.find((item) => item.draftTitle === "QA Campaign Draft");
  assert(committedCampaignItem && committedCampaignItem.campaignId, "Committed campaign item missing or unlinked.");
  assert(committedCampaignItem.campaignName === "Summer Launch Campaign", "Campaign name missing on committed item.");
  assert(committedCampaignItem.campaignVariantLabel === "Variant A", "Campaign variant label missing on committed item.");

  // Step 15b: verify Campaign provenance visible in Queue UI
  await open(page, "Queue");
  await page.locator(".campaign-provenance").filter({ hasText: "Summer Launch Campaign" }).first().waitFor();

  // Step 16: verify Planner can see scheduled row when scheduled
  await open(page, "Planner");
  await page.getByText("QA Campaign Draft").first().waitFor();

  // Step 17: verify no Facebook Post action occurred
  const publishState = await page.evaluate(() => window.publishApi.status());
  assert(publishState.running.length === 0, "Publish engine triggered during campaign workflow.");
  const attempts = await page.evaluate((id) => window.publishApi.attempts(id), committedCampaignItem.id);
  assert(attempts.length === 0, "Facebook publish attempts detected for campaign queue item.");

  const exportPaths = { csv: join(userData, "publishing-history.csv"), json: join(userData, "operations-report.json") };
  await first.application.evaluate(({ dialog }, paths) => { let call = 0; dialog.showSaveDialog = async () => ({ canceled: false, filePath: call++ === 0 ? paths.csv : paths.json }); }, exportPaths);
  await page.evaluate(async () => { await window.operationsApi.exportHistoryCsv({}); await window.publishApi.exportReport(); });
  const csvText = readFileSync(exportPaths.csv, "utf8"); const jsonText = readFileSync(exportPaths.json, "utf8"); assert(csvText.includes("automated result") && csvText.includes("final status") && csvText.includes("campaign name"), "CSV export headers are incomplete."); assert(jsonText.includes('"selectorVersion": "2026-08-v4"') && jsonText.includes('"platform"'), "Diagnostic JSON fields missing."); for (const forbidden of ["SHOULD-NOT-EXPORT", "proxy password", "session storage"]) assert(!csvText.includes(forbidden) && !jsonText.includes(forbidden), `Export leaked forbidden content: ${forbidden}`);
  const maintenance = await page.evaluate(async () => ({
    backup: await window.operationsApi.createBackup(),
    storage: await window.operationsApi.storageUsage(),
    orphan: await window.operationsApi.scanOrphanMedia(),
    about: await window.operationsApi.about(),
    integrity: await window.operationsApi.integrityCheck(),
    accountOps: await window.accountApi.operations(),
    groupOps: await window.groupApi.operations(),
  }));
  assert(
    maintenance.backup.schemaVersion === 8,
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
  assert(maintenance.about.appVersion === "0.8.0", "About version mismatch.");
  assert(maintenance.integrity.integrityOk === true, "Integrity check failed.");
  assert(maintenance.integrity.schemaVersion === 8, "Integrity schema version mismatch.");
  assert(maintenance.integrity.foreignKeyViolations === 0, "Integrity check reported FK violations.");
  assert(maintenance.integrity.missingTables.length === 0, "Integrity check reported missing tables.");
  assert(
    maintenance.accountOps.find((item) => item.accountId === seeded.accountId)?.pendingQueue === 3,
    "Account queue linkage mismatch.",
  );
  assert(
    maintenance.groupOps[0].activeQueueCount === 3,
    "Group queue aggregate mismatch.",
  );
  await first.application.close();
  activeApplication = undefined;
  const second = await launch();
  const persisted = await second.page.evaluate(async (onboardingAccountId) => ({
    queue: await window.queueApi.list({}),
    status: await window.publishApi.status(),
    settings: await window.settingsApi.getPublishing(),
    accounts: await window.accountApi.list(),
    onboarding: await window.onboardingApi.get(onboardingAccountId),
    accountSessions: await window.onboardingApi.sessionDetail(onboardingAccountId),
  }), seeded.accountId);
  assert(persisted.queue.length === 3, "Queue did not persist across restart.");
  assert(
    persisted.status.schedulerState === "DISARMED",
    "Scheduler arming persisted across restart.",
  );
  assert(
    persisted.settings.maxJobsPerSchedulerSession === 3,
    "Scheduler session cap setting did not persist.",
  );
  assert(persisted.settings.batchPacingSeconds === 10, "Batch pacing setting did not persist.");
  assert(persisted.settings.requireReadyAccounts === true, "READY scheduler gate setting did not persist.");
  assert(persisted.onboarding.account.onboardingStatus === "READY" && persisted.accountSessions.sessions.length === 2 && persisted.accountSessions.sessions[0].completionReason === "TARGET_REACHED" && persisted.accountSessions.sessions[1].completionReason === "OPERATOR_ENDED" && !persisted.accountSessions.activeSession, "Completed multi-session target did not persist safely across restart.");
  const persistedProxy = persisted.accounts.find((account) => account.name === "QA Proxy Account");
  assert(persistedProxy?.proxyPasswordSaved === true && !persistedProxy.proxyPasswordKey, "Encrypted proxy credential did not persist safely.");
  const restartProxyTest = await second.page.evaluate((account) => window.accountApi.testProxy({ accountId: account.id, proxyProtocol: account.proxyProtocol, proxyHost: account.proxyHost, proxyPort: account.proxyPort, proxyUsername: account.proxyUsername }), persistedProxy);
  assert(restartProxyTest.success && restartProxyTest.ip === "203.0.113.77", "Saved proxy credential could not be retested after restart.");
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
        "campaign workspace v1 end-to-end",
        "backup",
        "storage",
        "sanitized exports",
        "fixed proxy parser/test/status",
        "encrypted proxy credential restart",
        "main-process target completion and checkpoint priority",
        "canary multi-item guard and batch pacing persistence",
        "same-day accumulated progress in renderer",
        "restart persistence",
      ],
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  try { await activeApplication?.close(); } catch { /* best effort */ }
  if (proxyServer) await new Promise((resolveClose) => proxyServer.close(resolveClose));
  if (browserServer) await new Promise((resolveClose) => browserServer.close(resolveClose));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* Windows may release Chromium files shortly after exit */ }
}
