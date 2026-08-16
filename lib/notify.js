/**
 * AFK channels for the obvious-grid Host plugin: ntfy push (phone) + optional
 * alarm command (sound on the machine), plus the per-session / global config
 * store. The DSH analogue of opencode-obvious-grid's lib/notify.js, with the
 * platform-sound discovery problem removed: `alarmCmd` is a user-supplied
 * shell command (e.g. `paplay /usr/share/sounds/...`), so there is no
 * powershell/afplay/paplay guessing.
 *
 * SAFETY RULES (same discipline as the original plugin):
 *   - fetch is always bounded: AbortController + NETWORK_TIMEOUT_MS.
 *   - the alarm subprocess is spawned detached, stdio ignored, unref'd, and
 *     killed after SUBPROCESS_TIMEOUT_MS — it can never hang the harness.
 *   - config file I/O swallows errors; a broken store must not break the UI.
 *
 * No top-level side effects.
 */

import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const NETWORK_TIMEOUT_MS = 3000
const SUBPROCESS_TIMEOUT_MS = 5000

export const CONFIG_DIR = path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"))
const CONFIG_PATH = path.join(CONFIG_DIR, "obvious-grid.json")

/** Load the user-facing config: { topic, sessions: { [sessionID]: boolean } }. */
export function loadUserConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8").trim()
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object") return parsed
  } catch {}
  return {}
}

/** Merge a patch and write back atomically. Never throws. */
export function saveUserConfig(patch) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    const next = { ...loadUserConfig(), ...patch }
    const tmp = CONFIG_PATH + ".tmp"
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n")
    fs.renameSync(tmp, CONFIG_PATH)
  } catch {}
}

/** Per-session notify toggle; absent means "off" (opt-in, like the original). */
export function notifyEnabledFor(userConfig, sessionID) {
  const sessions = userConfig?.sessions
  return !!(sessions && typeof sessions === "object" && sessions[sessionID] === true)
}

function describe(rec) {
  const name = rec.sessionTitle || rec.sessionID || "session"
  return rec.cwd ? name + " · " + rec.cwd : name
}

export function messageFor(rec, kind, extra) {
  const who = describe(rec)
  const tokens = rec.outputTokens + rec.inputTokens + rec.cacheReadTokens + rec.cacheWriteTokens
  const stats = rec.turns + " turns, " + rec.steps + " steps, " + tokens + " tokens"
  switch (kind) {
    case "turn-end":
      return { title: "obvious-grid: turn finished", body: who + " — " + stats }
    case "approval-wait":
      return {
        title: "obvious-grid: waiting on you",
        body: who + " is blocked on an approval" + (extra?.toolName ? " (" + extra.toolName + ")" : "") + " — " + stats,
      }
    case "error":
      return { title: "obvious-grid: error", body: who + " — " + (rec.lastError || "step failed") + " · " + stats }
    default:
      return { title: "obvious-grid", body: who + " — " + stats }
  }
}

/** Bounded ntfy push. Resolves false on timeout/failure; never throws. */
export async function sendNtfy(ntfyUrl, topic, body, title) {
  if (!topic) return false
  const base = String(ntfyUrl || "https://ntfy.sh").replace(/\/+$/, "")
  const url = base + "/" + encodeURIComponent(topic)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: "POST",
      body,
      headers: {
        Title: title ?? "obvious-grid",
        "Content-Type": "text/plain; charset=utf-8",
      },
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Optional alarm sound. Detached + unref'd + kill-on-timeout so the harness
 * never waits on it. No-op when alarmCmd is empty.
 */
export function playAlarm(alarmCmd) {
  if (!alarmCmd) return
  let child
  try {
    child = spawn(alarmCmd, { shell: true, detached: true, stdio: "ignore" })
  } catch {
    return
  }
  if (!child) return
  const killer = setTimeout(() => {
    try {
      child.kill()
    } catch {}
  }, SUBPROCESS_TIMEOUT_MS)
  child.once("exit", () => clearTimeout(killer))
  child.unref()
}
