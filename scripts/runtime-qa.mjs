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
    env: { ...process.env, FB_ACCOUNT_MANAGER_USER_DATA: userData, FB_PROXY_TEST_ENDPOINTS: `http://proxy-test.invalid/ip`, FB_BROWSER_HOME_URL: `http://127.0.0.1:${browserPort}/facebook` },
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
      requireReadyAccounts: true,
    }),
  );
  await open(page, "Accounts");
  await page.getByRole("button", { name: "Import proxies" }).click();
  await page.locator("textarea.import-text").fill(`127.0.0.1:${proxyPort}\ninvalid proxy`);
  await page.getByRole("button", { name: "Preview" }).click();
  await page.getByText("Valid").first().waitFor();
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
  await open(page, "Account Onboarding");
  await page.locator(".onboarding-account").filter({ hasText: "QA Account" }).click();
  await page.getByRole("button", { name: "Start onboarding" }).click();
  await page.waitForTimeout(500);
  assert((await page.locator(".onboarding-detail").innerText()).includes("WARMING"), `Onboarding did not start: ${await page.locator("body").innerText()}`);
  await page.getByRole("button", { name: "Start Session", exact: true }).click();
  try {
    await page.waitForFunction(() => document.body.innerText.includes("ACTIVE") || Boolean(document.querySelector(".notice.error")), undefined, { timeout: 60_000 });
  } catch (error) {
    const state = await page.evaluate(async (accountId) => ({ account: await window.accountApi.list().then((accounts) => accounts.find((account) => account.id === accountId)), body: document.body.innerText }), seeded.accountId);
    throw new Error(`Account session wait failed: ${error instanceof Error ? error.message : String(error)}\nAccount: ${JSON.stringify(state.account)}\nUI: ${state.body}`);
  }
  assert((await page.locator("body").innerText()).includes("ACTIVE"), `Account session did not start: ${await page.locator("body").innerText()}`);
  await page.getByRole("button", { name: "Open Notifications", exact: true }).click();
  await page.getByText("Page opened in the existing persistent profile.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Pause Timer", exact: true }).click();
  await page.getByText("PAUSED", { exact: true }).first().waitFor();
  await page.getByRole("button", { name: "Resume Timer", exact: true }).click();
  await page.getByText("ACTIVE", { exact: true }).first().waitFor();
  browserFixtureMode = "CHECKPOINT";
  await page.getByRole("button", { name: "Health Check", exact: true }).click();
  await page.getByText("PAUSED", { exact: true }).first().waitFor();
  assert((await page.evaluate((accountId) => window.onboardingApi.sessionDetail(accountId), seeded.accountId)).sessions[0].status === "INTERRUPTED", "Checkpoint did not interrupt the account session.");
  browserFixtureMode = "READY";
  await page.getByRole("button", { name: "Health Check", exact: true }).click();
  await page.getByText("Health check: READY", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Resume onboarding" }).click();
  await page.waitForTimeout(500);
  assert((await page.locator(".onboarding-detail").innerText()).includes("WARMING"), `Onboarding did not resume: ${await page.locator("body").innerText()}`);
  await page.getByRole("button", { name: "Close Browser", exact: true }).click();
  await page.getByRole("button", { name: "Start Session", exact: true }).click();
  await page.getByText("ACTIVE", { exact: true }).first().waitFor();
  await page.waitForTimeout(1100);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "End Session", exact: true }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Mark READY" }).click();
  await page.getByText("READY", { exact: true }).first().waitFor();
  const onboardingRuntime = await page.evaluate(async (accountId) => ({ onboarding: await window.onboardingApi.get(accountId), sessions: await window.onboardingApi.sessionDetail(accountId) }), seeded.accountId);
  assert(onboardingRuntime.onboarding.account.onboardingStatus === "READY" && onboardingRuntime.sessions.sessions.length === 2 && onboardingRuntime.sessions.sessions[0].durationSeconds >= 1, "Account session lifecycle failed.");
  await open(page, "Dashboard");
  await page.getByText("Scheduled today", { exact: true }).waitFor();
  assert(
    (await page.evaluate(() => window.dashboardApi.summary())).today
      .scheduled === 2,
    "Dashboard counters did not use real queue data.",
  );
  assert((await page.evaluate(() => window.dashboardApi.summary())).onboarding.ready === 1, "Dashboard onboarding counters did not update.");
  assert((await page.evaluate(() => window.dashboardApi.summary())).accountSessions.sessionsToday === 2, "Dashboard account-session counters did not update.");
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
    maintenance.backup.schemaVersion === 7,
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
    maintenance.accountOps.find((item) => item.accountId === seeded.accountId)?.pendingQueue === 2,
    "Account queue linkage mismatch.",
  );
  assert(
    maintenance.groupOps[0].activeQueueCount === 2,
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
  assert(persisted.queue.length === 2, "Queue did not persist across restart.");
  assert(
    persisted.status.schedulerState === "DISARMED",
    "Scheduler arming persisted across restart.",
  );
  assert(
    persisted.settings.maxJobsPerSchedulerSession === 3,
    "Scheduler session cap setting did not persist.",
  );
  assert(persisted.settings.requireReadyAccounts === true, "READY scheduler gate setting did not persist.");
  assert(persisted.onboarding.account.onboardingStatus === "READY" && persisted.accountSessions.sessions.length === 2 && !persisted.accountSessions.activeSession, "Account session state did not persist safely across restart.");
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
        "backup",
        "storage",
        "sanitized exports",
        "fixed proxy parser/test/status",
        "encrypted proxy credential restart",
        "account session timer/navigation/health interruption",
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
