# dsh-obvious-grid

**npm**: [dsh-obvious-grid](https://www.npmjs.com/package/dsh-obvious-grid) · **source**: [github.com/ray062/dsh-obvious-grid](https://github.com/ray062/dsh-obvious-grid)

Host plugin for DeepSeek Harness: makes session status **obvious** — visible from
across the room and reaching you when you are AFK. Port of the *idea* of
[opencode-obvious-grid](https://github.com/ray062/opencode-obvious-grid) (its "HOW":
an ambient glanceable grid + push/alarm on turn-finished / error / approval-wait),
onto DSH's own seams instead of opencode hooks + temp files.

## What you get

- **Ambient grid page** served by the harness itself at `/obvious-grid` (web profile):
  a fullscreen port of opencode-obvious-grid's UI — distance-readable cards that
  fill the viewport, the whole card tinted by state: **orange = running** (with a
  giant scrolling RUNNING marquee), **blue = waiting / blocked on you**
  (flashing attention), **red = error**, **green = idle**. Cards show the
  session title (folded from the log-only `session/title` event, seeded from
  `ctx.sessionTitle` at adoption), workspace path · git branch (read from
  `.git/HEAD` up the directory tree), model/provider, per-request tokens
  (current request) + session totals, reasoning tokens (usage-reported when the
  adapter provides them, otherwise counted from the token-sized
  `reasoning-delta` stream chunks — the harness's own token boundaries),
  context-window % (the RAW prompt
  footprint of the newest measured request — uncached input + cache read over
  the window, NOT the session-cumulative cache total which would inflate the
  gauge to 100%+), prompt-cache hit % (last request | session average),
  token/s speed (last | average), per-state time breakdown (run/wait/idle/err)
  + pid + llm time in the meta line, sub-agent `↳` + parent line, per-card
  sound/notify toggles, hide/restore, and live per-request graphs (token usage
  stacked bars + token/s rate and average lines, hover for per-request detail
  with cumulative totals).
  Zero interaction required; the page polls `/obvious-grid/status` and stays live.
- **AFK notifications** on exactly three triggers (obvious-grid semantics):
  - `turn-end` — a turn finished, come look;
  - `error` — `agent/error` on the live bus;
  - `approval-wait` — an `approval/asked` is parked, you are the blocker.
  Each trigger pushes to **ntfy** (phone) and/or plays an **alarm** on the machine.
  Per-session opt-in toggles + a global topic, changed from the page; a global
  `notifyDefault` switch in config opts all sessions in.
- **History resumes across restarts**: DSH never rebroadcasts constructor
  seeds (replay/fork/resume) on the `session/event` firehose, so the registry
  folds each session's full event log (`session.events`) once at adoption —
  turns/steps/tokens/title from before a harness restart reappear, the
  opencode-obvious-grid behavior. Live appends keep coming from the firehose,
  and the two sources are disjoint (no double counting).
- **Nothing new to run**: no own HTTP server (routes register on the harness
  webserver), no temp-file registry, no PID liveness / staleness window. The
  page file is read fresh per request, so UI edits appear on a browser refresh
  without a harness restart.

## Install

```bash
dsh plugin --profile web add dsh-obvious-grid
dsh plugin --profile web add @deepseek-ai/schemastery
dsh web   # restart, then open http://localhost:3080/obvious-grid
```

That's it — the package ships a `dsh.bundle` manifest (its own
`cordis.patch.yml`), so `dsh plugin add` registers the plugin as a profile
layer automatically: no manual patch editing, no config file. (`dsh plugin`
forwards pnpm; for local development a tarball or `file:` path works the same
way, e.g. `dsh plugin --profile web add file:/path/to/dsh-obvious-grid`.)

### User-specific config (optional)

Per-user settings — your ntfy `topic`, `alarmCmd`, push defaults — belong in
the profile's own patch layer `$DSH_HOME/profiles/web/cordis.patch.yml` as an
**id-targeted** override (only the keys you set are needed):

```yaml
- id: obvious-grid
  config:
    topic: my-dsh-alerts        # ntfy topic; push is off until set
    notifyOn: [turn-end, error, approval-wait]
    notifyDefault: false        # true = notify all sessions unless overridden
    alarmCmd: ""                # e.g. paplay /usr/share/sounds/freedesktop/stereo/complete.oga
    minIntervalMs: 5000         # max one push per session per interval
    ntfyUrl: https://ntfy.sh
    pageEnabled: true
```

> Note for setups from before v0.2.0: if you previously registered the plugin by
> hand via an `insert` row in your profile patch, remove that row after

## Troubleshooting

- **`file:` / tarball installs are snapshots, not live links.** pnpm copies the
  package at install time, so after changing the source repo you must reinstall
  (re-run `dsh plugin --profile web add file:/path/to/dsh-obvious-grid`) —
  otherwise the installed copy silently keeps stale files. The npm-package
  install (`dsh plugin --profile web add dsh-obvious-grid`) avoids this.
- **Bundle not active after a `dsh plugin` command?** The reconciler maintains
  `dsh.profile.bundles` from installed state — the entry is added when the
  installed package declares `dsh.bundle`, and removed when it doesn't. If
  your copy is stale (see above), the manifest may be missing: refresh the
  install, then check `dsh.profile.bundles` in the profile's `package.json`
  contains `dsh-obvious-grid`.
- **Quick sanity check:** `/obvious-grid/status` must return JSON. If it
  returns the SPA shell (DeepSeek Harness app HTML) instead, the plugin did not
  register — check the two bullets above.

## Config

| Key | Default | Meaning |
|---|---|---|
| `ntfyUrl` | `https://ntfy.sh` | ntfy server base |
| `topic` | `""` | ntfy topic. Empty = push disabled (page can set it at runtime) |
| `notifyOn` | `[turn-end, error, approval-wait]` | which triggers push |
| `notifyDefault` | `false` | notify sessions that have no explicit per-session flag |
| `alarmCmd` | `""` | optional alarm shell command; unset = silent |
| `minIntervalMs` | `5000` | per-session push throttle |
| `pageEnabled` | `true` | mount the `/obvious-grid` routes (web profile) |

Runtime user config (topic + per-session toggles) lives in
`$DSH_HOME/obvious-grid.json` and is editable from the page
(`POST /obvious-grid/notify`).

## Endpoints (web profile)

| Route | Description |
|---|---|
| `GET /obvious-grid` | the ambient page (plain HTML file, zero build) |
| `GET /obvious-grid/status` | JSON snapshot of live sessions |
| `GET /obvious-grid/notify` | current topic + per-session flags |
| `POST /obvious-grid/notify` | set topic and/or toggle one session |

## Files

```
dsh-obvious-grid/
  lib/index.js       plugin entry: name, Config (schemastery), apply()
  lib/sessions.js    live per-session fold of the session firehose
  lib/notify.js      ntfy push + bounded alarm subprocess + user config store
  lib/page.html      the ambient grid page (plain file, no template processing)
  cordis.patch.yml   bundle patch layer (dsh.bundle manifest) — auto-registers the
                     plugin on `dsh plugin add`, no manual patch editing
  scripts/check-page-script.mjs  syntax-checks the page's embedded <script>
  scripts/seeder.mjs            test seeder: creates a multi-session grid (parent +
                                sub-agent + extra session) in an isolated profile to
                                exercise several cards without touching a live instance
```

## Safety rules (kept from the original plugin)

1. No top-level side effects; `apply(ctx, config)` does all wiring.
2. `fetch` is always bounded (AbortController, 3 s); the alarm subprocess is
   `detached`, `unref`'d, stdio ignored, killed after 5 s — it can never hang
   the harness.
3. All file config I/O swallows errors; a broken store must not break the page.
4. `lib/page.html` is a plain file — no template processing. The embedded script
   uses only string concatenation (no template literals), and `npm run check`
   syntax-checks it.

## Verify

```bash
npm run check   # node --check on lib/*.js + the extracted page script
```

**Verification limits:** this package was written against the published
`@deepseek-ai` package contracts (`dsh-session-telemetry` event subscription,
`dsh-host-webserver` route registration, `dsh-session-title-first-prompt-llm`
plugin shape, `dsh-session-stats` event vocabulary) and has been live-loaded
against DSH rc.6 in this environment: boot failed until the loader entry declared
`inject: [sessions, webServer, sessionTitle]` (cordis forbids touching
undeclared services), and `apply()` now reads services through a guarded
accessor so a missing service degrades instead of killing the boot. A
multi-session grid (parent + sub-agent + second session, waiting + idle states)
is exercised by `scripts/seeder.mjs` in an isolated profile. A load failure
still surfaces in the Loader log; the Logger row message names the missing
export, schema field, or service.

## Differences vs opencode-obvious-grid

- Data source: DSH session firehose (`session/event`) instead of opencode hooks;
  no temp state files, PID liveness, or staleness window.
- Server: routes on `ctx.webServer` instead of a plug-in-owned port + takeover;
  no platform player discovery (`powershell/afplay/paplay`) — `alarmCmd` is the
  user's own shell command.
- Cost: DSH reports no message cost today, so cards show tokens + wall times
  instead of $. If providers expose usage cost later, it drops into the same fold.
- Fleet: v1 shows the serving instance's live sessions. A machine-wide grid over
  several concurrent `dsh` processes would scan the shared canonical logs under
  `$DSH_HOME` — the open 20%, deliberately deferred.

## License

MIT. Idea and page design derive from
[ray062/opencode-obvious-grid](https://github.com/ray062/opencode-obvious-grid) (MIT).
