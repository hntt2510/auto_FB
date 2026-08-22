# Facebook Account Manager

Facebook Account Manager is a local Windows desktop foundation for managing multiple Facebook accounts with isolated Playwright persistent browser profiles. V1 handles account records, fixed per-account network settings, safe browser lifecycle, conservative session health checks, and audit logs.

It uses only the visible Facebook web interface for explicitly enabled publishing. It does **not** comment, scrape, rotate proxies, spoof fingerprints, bypass CAPTCHA/checkpoints, manipulate cookies, or automate Facebook login. Facebook username/password is **not stored by this application**.

## Architecture

- Electron main owns SQLite, filesystem access, Playwright, profile locks, and secrets.
- React/Vite renderer communicates through a small typed preload API.
- `src/shared` contains DTOs and Zod validation shared by the UI and main process.
- `AccountRepository`, `AuditLogRepository`, and `SettingsRepository` use prepared SQLite statements and migrations.
- `BrowserManager` launches one `chromium.launchPersistentContext()` per account and never exposes Playwright objects to the renderer.

## Installation and development

Requires Node.js 20+ and npm on Windows 10/11.

```bash
npm install
npm run dev
```

The install step downloads a local Playwright Chromium for packaging. The development data root is printed once at startup.

Verification and packaging commands:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

`npm run build` creates an NSIS installer and an unpacked Windows application under `release/`.

## Profiles and fixed proxies

Application data is stored below Electron's user data directory:

```text
{userData}/fb-account-manager/
├── app.db
├── profiles/
├── media/
└── logs/
```

Each account owns one filesystem-safe directory under `profiles/`. A profile directory is never shared between accounts. A configured proxy is fixed to that account and is applied only when its persistent context starts. Proxy passwords are encrypted with Electron `safeStorage`; SQLite stores only an opaque encrypted-secret key.

To add an account, click **Add account**, provide an account name and unique profile name, then choose Direct or Fixed proxy. Login is performed manually in the visible browser window. Closing and reopening the account reuses the same persistent profile.

## Health checks and safety

Health checks classify the current Facebook page conservatively as `READY`, `LOGIN_REQUIRED`, `CHECKPOINT`, or `ERROR`. A stopped account uses a temporary visible persistent context for the check and then closes it. A checkpoint, CAPTCHA, identity confirmation, recovery, suspicious-login, or locked-account signal stops further checking and displays **Manual user action required**.

The application prevents duplicate launches with an application single-instance lock and an account lock. Locks are released on normal close, browser crash, failed startup, and application shutdown.

## Content operations workspace

The sidebar includes Dashboard, Accounts, Groups, Drafts, Queue, and Audit Logs. Goal 2 adds local group records, indexed tags, account/group assignments, a managed media library, explicit draft saving, and a reviewable queue of immutable snapshots.

- Group URLs are normalized to `https://www.facebook.com/groups/{identifier}`. Group open is always a visible manual navigation through the selected assigned account; it never posts or publishes.
- Draft media is copied into `{userData}/fb-account-manager/media`, checked by extension and file signature, and served to the renderer only through the confined `app-media://asset/{id}` protocol. Images are limited to 25 MiB and videos to 500 MiB.
- Queue creation requires a READY draft and active account/group assignment. Items are immutable snapshots with `PENDING`, `PAUSED`, `RUNNING`, `SUBMITTED`, `SUCCEEDED`, `FAILED`, `NEEDS_ATTENTION`, or `CANCELLED` states; later draft edits do not change queued history.
- Scheduled times are entered locally and stored as UTC ISO timestamps. Due items are labelled for review; the opt-in publishing engine described below is the only execution path.

All workspace mutations are validated in the renderer and main process, use transactional repositories, and write concise audit events without draft bodies, media contents, cookies, tokens, or proxy passwords.

## Publishing engine

Goal 3 adds an opt-in visible-browser publishing engine. It is disabled by default and can be configured from **Settings**. The scheduler checks due, scheduled queue items at the configured interval; unscheduled items are manual-only. Manual **Run** actions always ask for confirmation, and a per-account serialization queue plus a global account limit prevents overlapping browser operations.

Each execution claims a queue row with a lease token, records an attempt timeline, and stores only sanitized status, error, receipt, and evidence metadata. A verified visible post link is required for `SUCCEEDED`; accepted submissions without conclusive evidence remain `SUBMITTED`, and ambiguous results become `NEEDS_ATTENTION`. The engine never clicks Post twice automatically and never retries after the irreversible submit boundary without explicit duplicate-risk acknowledgement.

If the application closes during execution, the lease and attempt are recovered on the next startup as `NEEDS_ATTENTION`. Login, checkpoint, CAPTCHA, identity, recovery, and locked-account signals open an account publishing block and stop further execution until a successful manual health check clears it. Diagnostics are limited to bounded screenshots under the ignored diagnostics directory; no cookies, tokens, passwords, full page HTML, or media contents are stored.

The Facebook composer adapter uses visible UI selectors that may change as Facebook changes. A failed or uncertain selector interaction is surfaced as a safe failure and requires manual review. There is no private API, scraping, stealth behavior, CAPTCHA bypass, credential entry, proxy rotation, or automated background Facebook activity.

## Publishing safety and reconciliation

Publishing has two independent controls: the engine switch and **Execution mode**. New installations default to `DRY_RUN`. Dry run opens the account, group, composer, textbox, managed media input, and scoped Post button, optionally fills the snapshot, records selector/preflight diagnostics, and stops before clicking Post. The scheduler never claims work while dry run is selected. Switching to `LIVE` requires an explicit confirmation and remains subject to the existing manual-run confirmation.

`SUBMITTED` means Facebook accepted the submission interaction but this application did not verify public publication. `SUCCEEDED` requires a newly observed, current-group-correlated post link plus acceptance and matching content evidence. Existing post links are captured before submission and cannot be reused as proof. Ambiguous results become `NEEDS_ATTENTION`; they are never automatically retried.

Terminal publishing changes are committed atomically with the receipt, attempt status, queue state, lease cleanup, timestamps, and terminal event. On restart, stale executions become `NEEDS_ATTENTION` with different guidance for interruption before or after the submit boundary. Operators can open the group, mark an item submitted, manually mark it verified with retained operator evidence, requeue it as a new snapshot, or retry only after acknowledging duplicate risk. Historical `SUBMITTED` items no longer block source deletion or active duplicate creation.

Selector probes record the account, group, selector version, field-level `FOUND`/`MISSING`/`AMBIGUOUS` state, warnings, and timestamp. Diagnostics remain local, confined to the managed diagnostics root, bounded by retention, and can be deleted from attempt detail. No credentials, cookies, tokens, page HTML, or media contents are stored in probes, attempts, receipts, or audit logs.

## Troubleshooting

- **Account already running:** close the existing browser window or restart the application if a browser crashed before its close event was delivered.
- **Proxy connection or authentication failed:** verify host, port, and credentials. Passwords are never printed to logs.
- **Chromium launch failed:** check that the profile is not open in another browser process and that the installed build includes its Playwright browser resources.
- **Checkpoint or CAPTCHA:** complete the required action manually in the browser; the app will not attempt to bypass it.
- **Profile deletion:** deleting a database record preserves the profile directory. The stronger delete option removes only the validated directory inside the application profiles root.

## Scope

This release intentionally stops at safe account/profile lifecycle, manual content operations, and the opt-in visible-browser publishing engine described above. Comments, scraping, credential entry, CAPTCHA handling, stealth behavior, proxy rotation, and security bypasses remain out of scope.
