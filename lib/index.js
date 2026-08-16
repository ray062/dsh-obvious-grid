/**
 * obvious-grid — DeepSeek Harness Host plugin. Entry module: event wiring,
 * AFK notifications (ntfy + alarm), ambient status page served by the
 * harness's own webserver.
 *
 * The idea, ported from opencode-obvious-grid: make session status OBVIOUS —
 * glanceable from across the room (the page is a dark ambient grid, not a
 * chat UI) and reaching the human when they are away (push + sound on
 * turn-finished / error / approval-wait). The information is DSH's own; this
 * plugin only adds the attention channel.
 *
 * DSH seams used (verified against @deepseek-ai/dsh-session-telemetry and
 * dsh-host-webserver):
 *   ctx.on("session/created" | "session/event" | "session/disposed")
 *   ctx.on("agent/error", ({ agent, error }) => ...)       — live-bus relay
 *   ctx.webServer.register({ kind: "exact", path, handler }) — node:http (req, res)
 *   Config schema via @deepseek-ai/schemastery (z)
 *
 * SAFETY (same discipline as the original plugin):
 *   - no top-level side effects; apply() does all the wiring.
 *   - every fetch is bounded (AbortController, 3s); every subprocess is
 *     detached + unref'd + kill-on-timeout (notify.js).
 *   - all I/O swallows errors: the plugin must never take the harness down.
 */
import z from "@deepseek-ai/schemastery"
import fs from "node:fs"
import { createRegistry } from "./sessions.js"
import {
  loadUserConfig,
  saveUserConfig,
  notifyEnabledFor,
  messageFor,
  sendNtfy,
  playAlarm,
} from "./notify.js"

const name = "obvious-grid"
// Single source of truth for the version: package.json.
const { createRequire } = await import("node:module")
const PKG_VERSION = createRequire(import.meta.url)("../package.json").version
const PLUGIN_VERSION = PKG_VERSION

const NOTIFY_KINDS = ["turn-end", "error", "approval-wait"]

const Config = z.object({
  ntfyUrl: z.string().default("https://ntfy.sh"),
  topic: z.string().default(""),
  notifyOn: z.array(z.string()).default(["turn-end", "error", "approval-wait"]),
  notifyDefault: z.boolean().default(false),
  alarmCmd: z.string().default(""),
  minIntervalMs: z.number().default(5000),
  pageEnabled: z.boolean().default(true),
})

// Read fresh on every request: the page is a plain file and re-reading keeps
// UI edits one browser refresh away instead of requiring a harness restart.
function loadPageHtml() {
  try {
    return fs.readFileSync(new URL("./page.html", import.meta.url), "utf8")
  } catch {
    return "<!doctype html><html><body><h1>page.html missing</h1></body></html>"
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = ""
    req.on("data", (chunk) => {
      body += chunk
    })
    req.on("end", () => resolve(body))
    req.on("error", () => resolve(body))
  })
}

/** Read a cordis service property safely; accessing an undeclared service
 * throws, and this plugin must degrade (no page, no adoption) — never crash
 * the boot. Register the services you want on the loader entry instead. */
function tryService(ctx, name) {
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

function sendJson(res, status, payload) {
  const json = JSON.stringify(payload)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  })
  res.end(json)
}

function apply(ctx, config) {
  const registry = createRegistry()
  const lastNotify = new Map()
  const notifyOn = (config.notifyOn ?? []).filter((k) => NOTIFY_KINDS.includes(k))
  // Seed history once per session: the firehose never broadcasts constructor
  // seeds (replay/fork/resume), so a resumed or sub-agent session's pre-load
  // history lives only in session.events. Fold the full log once; the live
  // firehose then adds only post-seed appends, so the two sources are disjoint.
  const replayed = new Set()

  function maybeNotify(rec, kind, extra) {
    try {
      const userCfg = loadUserConfig()
      const enabled = userCfg.sessions && userCfg.sessions[rec.sessionID] !== undefined
        ? notifyEnabledFor(userCfg, rec.sessionID)
        : config.notifyDefault
      if (!enabled) return
      const now = Date.now()
      const last = lastNotify.get(rec.sessionID) ?? 0
      if (now - last < config.minIntervalMs) return
      lastNotify.set(rec.sessionID, now)
      const topic = userCfg.topic || config.topic
      const { title, body } = messageFor(rec, kind, extra)
      sendNtfy(config.ntfyUrl, topic, body, title)
      playAlarm(config.alarmCmd)
    } catch {}
  }

  ctx.on("session/created", (session) => {
    registry.onCreated(session)
    registry.adoptContext(session)
    if (session?.id && !replayed.has(session.id)) {
      replayed.add(session.id)
      registry.replayEvents(session)
    }
    let title = null
    try {
      const st = ctx.sessionTitle
      title = st?.get?.(session)?.title ?? null
    } catch {}
    if (title) registry.setTitle(session?.id, title)
  })
  ctx.on("session/event", (session, event) => {
    if (!session || !event) return
    const rec = registry.onEvent(session, event)
    if (event.type === "turn/end" && notifyOn.includes("turn-end")) maybeNotify(rec, "turn-end")
    else if (event.type === "approval/asked" && notifyOn.includes("approval-wait")) maybeNotify(rec, "approval-wait", event.data)
  })
  ctx.on("agent/error", ({ agent, error }) => {
    const session = agent?.session
    if (!session) return
    const rec = registry.onAgentError(session, error)
    if (notifyOn.includes("error")) maybeNotify(rec, "error")
  })
  ctx.on("session/disposed", (session) => {
    registry.onDisposed(session)
  })

  // Adopt sessions already open when this plugin activates (late load, reload).
  // Service access is guarded — cordis throws on undeclared services.
  const sessionService = tryService(ctx, "sessions")
  const list = sessionService?.list?.()
  if (Array.isArray(list)) {
    for (const session of list) {
      registry.onCreated(session)
      registry.adoptContext(session)
      if (session?.id && !replayed.has(session.id)) {
        replayed.add(session.id)
        registry.replayEvents(session)
      }
      let title = null
      try {
        const st = ctx.sessionTitle
        title = st?.get?.(session)?.title ?? null
      } catch {}
      if (title) registry.setTitle(session?.id, title)
    }
  }

  // Ambient page + config routes — only in the web profile (webServer present).
  const webServer = tryService(ctx, "webServer")
  if (config.pageEnabled && webServer && typeof webServer.register === "function") {
    const register = (path, handler) => {
      try {
        webServer.register({ kind: "exact", path, handler })
      } catch (e) {
        ctx.logger?.warn?.("obvious-grid: route " + path + " unavailable: " + String(e))
      }
    }
    register("/obvious-grid", (req, res) => {
      const html = loadPageHtml()
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(html)
    })
    register("/obvious-grid/status", (req, res) => {
      sendJson(res, 200, registry.snapshot())
    })
    register("/obvious-grid/notify", async (req, res) => {
      if (req.method === "POST") {
        try {
          const text = (await readBody(req)) || "{}"
          const body = JSON.parse(text)
          const patch = {}
          if (body && typeof body.topic === "string") patch.topic = body.topic.trim() || null
          if (body && typeof body.sessionID === "string" && typeof body.enabled === "boolean") {
            const sessions = { ...(loadUserConfig().sessions ?? {}) }
            sessions[body.sessionID] = body.enabled
            patch.sessions = sessions
          }
          saveUserConfig(patch)
        } catch {}
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
        res.end("ok")
        return
      }
      const userCfg = loadUserConfig()
      sendJson(res, 200, {
        topic: userCfg.topic || config.topic,
        notifyDefault: config.notifyDefault,
        sessions: userCfg.sessions ?? {},
      })
    })
  }

  ctx.logger?.info?.("obvious-grid v" + PLUGIN_VERSION + " active (notify: " + notifyOn.join(",") + ")")
}

export { name, Config, apply }
