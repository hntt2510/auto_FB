# Facebook Account Manager

Facebook Account Manager is a local Windows desktop foundation for managing multiple Facebook accounts with isolated Playwright persistent browser profiles. V1 handles account records, fixed per-account network settings, safe browser lifecycle, conservative session health checks, and audit logs.

It deliberately does **not** post, comment, scrape, rotate proxies, spoof fingerprints, bypass CAPTCHA/checkpoints, manipulate cookies, or automate Facebook login. Facebook username/password is **not stored by this application**.

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
- Queue creation requires a READY draft and active account/group assignment. Items are `PENDING`, `PAUSED`, or `CANCELLED`; content and media are snapshotted at creation, so later draft edits do not change queued history.
- Scheduled times are entered locally and stored as UTC ISO timestamps. Due items are labelled for review only; there is no executor or background publishing process.

All workspace mutations are validated in the renderer and main process, use transactional repositories, and write concise audit events without draft bodies, media contents, cookies, tokens, or proxy passwords.

## Troubleshooting

- **Account already running:** close the existing browser window or restart the application if a browser crashed before its close event was delivered.
- **Proxy connection or authentication failed:** verify host, port, and credentials. Passwords are never printed to logs.
- **Chromium launch failed:** check that the profile is not open in another browser process and that the installed build includes its Playwright browser resources.
- **Checkpoint or CAPTCHA:** complete the required action manually in the browser; the app will not attempt to bypass it.
- **Profile deletion:** deleting a database record preserves the profile directory. The stronger delete option removes only the validated directory inside the application profiles root.

## Scope

This release intentionally stops at safe account/profile lifecycle and manual content operations. Automatic publishing, comments, scraping, credential entry, CAPTCHA handling, stealth behavior, proxy rotation, and security bypasses remain out of scope.
