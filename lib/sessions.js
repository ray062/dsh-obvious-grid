import fs from "node:fs"
import path from "node:path"

/**
 * Live per-session registry for the obvious-grid Host plugin.
 *
 * The DeepSeek Harness analogue of opencode-obvious-grid's lib/state.js: an
 * incremental fold of the session firehose (ctx.on("session/event")) into one
 * record per session. State machine is the same four states — idle / running /
 * waiting / error — but the sources are DSH events instead of opencode hooks:
 *
 *   running        <- step/start                       (a step is executing)
 *   waiting        <- approval/asked                   (blocked on the human)
 *   idle           <- turn/end, assistant/message, approval/decided
 *   error          <- ctx.on("agent/error") bus        (the one live-bus relay)
 *
 * Token figures come from assistant/message usage buckets (input/output/cache
 * read/cache write). No temp files, no PID liveness, no staleness window: the
 * registry is process-local and dies with the harness, exactly like the rest of
 * DSH's live runtime state.
 *
 * No top-level side effects; no dependencies outside node builtins.
 */

const STATE_IDLE = "idle"
const STATE_RUNNING = "running"
const STATE_WAITING = "waiting"
const STATE_ERROR = "error"

// Per-request graph series (for the card graphs, opencode-obvious-grid style).
// tokSeries: [time, input, output, reasoning, cacheRead]; rateSeries:
// [time, output+reasoning, durationMs]. Bounded so the registry cannot grow
// without limit on long sessions.
const MAX_SERIES = 400
function pushSeries(arr, point) {
  arr.push(point)
  if (arr.length > MAX_SERIES) arr.shift()
}

/** Best-effort git branch (or short hash when detached) by reading .git/HEAD
 *  up the directory tree. Plain sync file reads only — no subprocess. */
function detectBranch(cwd) {
  try {
    if (!cwd || typeof cwd !== "string") return null
    let dir = cwd
    for (let depth = 0; depth < 8; depth++) {
      let content = null
      try {
        content = fs.readFileSync(path.join(dir, ".git", "HEAD"), "utf8")
      } catch {}
      if (content) {
        const m = /^ref:\s*refs\/heads\/(.+)$/m.exec(content.trim())
        if (m) return m[1]
        const hash = /^[0-9a-f]{40}$/i.test(content.trim()) ? content.trim().slice(0, 7) : null
        return hash || null
      }
      const parent = path.dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  } catch {}
  return null
}

function makeRecord(session) {
  const now = Date.now()
  return {
    sessionID: session?.id ?? null,
    sessionTitle: session?.title ?? null,
    cwd: session?.cwd ?? session?.header?.cwd ?? null,
    parentID: session?.parent_id ?? session?.header?.parentSession ?? null,
    branch: null,
    state: STATE_IDLE,
    stateSince: now,
    sessionStart: now,
    lastActivity: null,
    lastError: null,
    turns: 0,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    lastMessageOutputTokens: null,
    pendingApprovals: 0,
    errors: 0,
    llmMs: 0,
    openStep: null,
    tokSeries: [],
    rateSeries: [],
    model: null,
    provider: null,
    contextWindow: null,
    messageCount: 0,
    userCalls: 0,
    apiCalls: 0,
    stateMs: { running: 0, waiting: 0, idle: 0, error: 0 },
    pid: null,
  }
}

function bump(rec, state, now) {
  if (rec.state !== state) {
    const prev = rec.state
    if (rec.stateMs && prev && now > rec.stateSince) {
      rec.stateMs[prev] = (rec.stateMs[prev] || 0) + (now - rec.stateSince)
    }
    rec.state = state
    rec.stateSince = now
  }
}

export function createRegistry() {
  const records = new Map()

  function recordFor(session) {
    let rec = records.get(session?.id)
    if (!rec) {
      rec = makeRecord(session)
      rec.branch = detectBranch(rec.cwd)
      records.set(session.id, rec)
    }
    return rec
  }

  return {
    onCreated(session) {
      if (!session?.id) return
      if (!records.has(session.id)) {
        const rec = makeRecord(session)
        rec.sessionStart = Date.now()
        rec.pid = typeof process !== "undefined" ? process.pid : null
        rec.branch = detectBranch(rec.cwd)
        records.set(session.id, rec)
      }
    },

    onDisposed(session) {
      if (session?.id) records.delete(session.id)
    },

    /** Fold route metadata from the session object when the firehose missed it
     *  (session adopted after its request/context already fired). Defensive. */
    adoptContext(session) {
      const rec = session?.id ? recordFor(session) : null
      if (!rec) return
      try {
        const rc = session.requestContext?.()
        if (rc && typeof rc === "object") {
          if (typeof rc.model === "string") rec.model = rc.model
          if (typeof rc.provider === "string") rec.provider = rc.provider
          if (typeof rc.contextWindow === "number") rec.contextWindow = rc.contextWindow
        }
      } catch {}
      const header = session?.requestHeader?.()
      if (header && !rec.model && header.config) {
        if (typeof header.config.model === "string") rec.model = header.config.model
        if (typeof header.config.provider === "string") rec.provider = header.config.provider
      }
    },

    /** Set (or clear) the folded session title directly. */
    setTitle(sessionId, title) {
      if (sessionId == null) return
      const rec = records.get(sessionId)
      if (!rec) return
      if (typeof title === "string" && title.length > 0) rec.sessionTitle = title
    },

    /**
     * Replay the session's complete event log to reconstruct history the live
     * firehose never emitted (constructor seeds from replay/fork/resume are not
     * broadcast). This is how the grid resumes historical turns/steps/tokens
     * after a harness restart — the opencode-obvious-grid goal.
     */
    replayEvents(session) {
      const rec = session?.id ? recordFor(session) : null
      if (!rec) return
      let events = null
      try {
        events = session.events
      } catch {}
      if (!Array.isArray(events)) return
      for (const event of events) {
        if (!event || typeof event !== "object") continue
        const now = typeof event.time === "number" ? event.time : Date.now()
        rec.lastActivity = Math.max(rec.lastActivity ?? 0, now)
        switch (event.type) {
          case "session/title": {
            const t = event?.data?.title
            if (typeof t === "string" && t.length > 0) rec.sessionTitle = t
            break
          }
          case "request/context": {
            const rc = event?.data
            if (rc && typeof rc === "object") {
              if (typeof rc.model === "string") rec.model = rc.model
              if (typeof rc.provider === "string") rec.provider = rc.provider
              if (typeof rc.contextWindow === "number") rec.contextWindow = rc.contextWindow
            }
            break
          }
          case "user/message":
            rec.userCalls += 1
            break
          case "step/start":
            rec.apiCalls += 1
            bump(rec, STATE_RUNNING, now)
            rec.openStep = { startedAt: now, reasoningChunks: 0 }
            break
          case "assistant/chunk":
            if (event?.data?.chunk && typeof event.data.chunk === "object" && event.data.chunk.type === "reasoning-delta" && rec.openStep) {
              rec.openStep.reasoningChunks = (rec.openStep.reasoningChunks || 0) + 1
            }
            break
          case "step/end":
            rec.steps += 1
            rec.openStep = null
            break
          case "turn/end":
            rec.turns += 1
            if (rec.state !== STATE_ERROR && rec.state !== STATE_WAITING) bump(rec, STATE_IDLE, now)
            break
          case "assistant/message": {
            let dur = 0
            let chunkReasoning = 0
            if (rec.openStep) {
              dur = Math.max(0, now - rec.openStep.startedAt)
              rec.llmMs += dur
              chunkReasoning = rec.openStep.reasoningChunks || 0
              rec.openStep = null
            }
            const usage = event?.data?.usage
            if (usage && typeof usage === "object") {
              const input = usage.uncachedInputTokens ?? usage.inputTokens ?? 0
              const output = usage.outputTokens ?? 0
              const usageReasoning = usage.reasoningTokens ?? 0
              const reasoning = usageReasoning > 0 ? usageReasoning : chunkReasoning
              const cache = usage.cacheReadTokens ?? 0
              rec.inputTokens += input
              rec.outputTokens += output
              rec.reasoningTokens += reasoning
              rec.cacheReadTokens += cache
              rec.cacheWriteTokens += usage.cacheWriteTokens ?? 0
              rec.lastMessageOutputTokens = output || null
              rec.messageCount += 1
              pushSeries(rec.tokSeries, [now, input, output, reasoning, cache])
              pushSeries(rec.rateSeries, [now, output + reasoning, dur])
            }
            if (rec.state === STATE_RUNNING) bump(rec, STATE_IDLE, now)
            break
          }
          case "approval/asked":
            rec.pendingApprovals += 1
            bump(rec, STATE_WAITING, now)
            break
          case "approval/decided":
            rec.pendingApprovals = Math.max(0, rec.pendingApprovals - 1)
            if (rec.pendingApprovals === 0 && rec.state === STATE_WAITING) bump(rec, STATE_IDLE, now)
            break
          default:
            break
        }
      }
      // After a full replay the session is resting at its final state.
      const lastTime = Array.isArray(events) && events.length
        ? (typeof events[events.length - 1].time === "number" ? events[events.length - 1].time : Date.now())
        : Date.now()
      if (rec.state === STATE_RUNNING) {
        bump(rec, STATE_IDLE, lastTime)
      }
    },

    /**
     * Fold one session/event (event = { type, time, seq, data }).
     * Returns the touched record.
     */
    onEvent(session, event) {
      const rec = recordFor(session)
      const now = event?.time ?? Date.now()
      rec.lastActivity = Math.max(rec.lastActivity ?? 0, now)
      switch (event?.type) {
        case "user/message": {
          rec.userCalls += 1
          break
        }
        case "step/start": {
          rec.apiCalls += 1
          bump(rec, STATE_RUNNING, now)
          rec.openStep = { startedAt: now, reasoningChunks: 0 }
          break
        }
        case "step/end": {
          rec.steps += 1
          rec.openStep = null
          break
        }
        case "turn/end": {
          rec.turns += 1
          if (rec.state !== STATE_ERROR && rec.state !== STATE_WAITING) bump(rec, STATE_IDLE, now)
          break
        }
        case "session/title": {
          const title = event?.data?.title
          if (typeof title === "string" && title.length > 0) rec.sessionTitle = title
          else if (typeof event?.data?.title === "string" && rec.sessionTitle == null) rec.sessionTitle = event.data.title
          break
        }
        case "request/context": {
          const rc = event?.data
          if (rc && typeof rc === "object") {
            if (typeof rc.model === "string") rec.model = rc.model
            if (typeof rc.provider === "string") rec.provider = rc.provider
            if (typeof rc.contextWindow === "number") rec.contextWindow = rc.contextWindow
          }
          break
        }
        case "assistant/chunk": {
          const chunk = event?.data?.chunk
          if (chunk && typeof chunk === "object" && chunk.type === "reasoning-delta" && rec.openStep) {
            rec.openStep.reasoningChunks = (rec.openStep.reasoningChunks || 0) + 1
          }
          break
        }
        case "assistant/message": {
          let dur = 0
          let chunkReasoning = 0
          if (rec.openStep) {
            dur = Math.max(0, now - rec.openStep.startedAt)
            rec.llmMs += dur
            chunkReasoning = rec.openStep.reasoningChunks || 0
            rec.openStep = null
          }
          const usage = event?.data?.usage
          if (usage && typeof usage === "object") {
            const input = usage.uncachedInputTokens ?? usage.inputTokens ?? 0
            const output = usage.outputTokens ?? 0
            /* The adapter may not report reasoning tokens in usage (opencode-go
               doesn't); fall back to counting the token-sized reasoning-delta
               stream chunks for the step — the harness's own token boundaries. */
            const usageReasoning = usage.reasoningTokens ?? 0
            const reasoning = usageReasoning > 0 ? usageReasoning : chunkReasoning
            const cache = usage.cacheReadTokens ?? 0
            rec.inputTokens += input
            rec.outputTokens += output
            rec.reasoningTokens += reasoning
            rec.cacheReadTokens += cache
            rec.cacheWriteTokens += usage.cacheWriteTokens ?? 0
            rec.lastMessageOutputTokens = output || null
            rec.messageCount += 1
            pushSeries(rec.tokSeries, [now, input, output, reasoning, cache])
            pushSeries(rec.rateSeries, [now, output + reasoning, dur])
          }
          if (rec.state === STATE_RUNNING) bump(rec, STATE_IDLE, now)
          break
        }
        case "approval/asked": {
          rec.pendingApprovals += 1
          bump(rec, STATE_WAITING, now)
          break
        }
        case "approval/decided": {
          rec.pendingApprovals = Math.max(0, rec.pendingApprovals - 1)
          if (rec.pendingApprovals === 0 && rec.state === STATE_WAITING) bump(rec, STATE_IDLE, now)
          break
        }
        default:
          break
      }
      return rec
    },

    /** agent/error arrives on the live bus, not the session firehose. */
    onAgentError(agentSession, error) {
      const rec = recordFor(agentSession)
      rec.errors += 1
      rec.state = STATE_ERROR
      rec.stateSince = Date.now()
      rec.lastActivity = Date.now()
      rec.lastError = typeof error === "object" && error !== null ? String(error.message ?? "") : String(error ?? "")
      return rec
    },

    get(id) {
      return records.get(id)
    },

    size() {
      return records.size
    },

    /** Card rows for /obvious-grid/status. Plain JSON-safe objects. */
    snapshot() {
      const instances = []
      let running = false
      let errored = false
      let waiting = false
      for (const rec of records.values()) {
        if (rec.state === STATE_RUNNING) running = true
        else if (rec.state === STATE_ERROR) errored = true
        else if (rec.state === STATE_WAITING) waiting = true
        instances.push({
          sessionID: rec.sessionID,
          sessionTitle: rec.sessionTitle,
          cwd: rec.cwd,
          branch: rec.branch,
          parentID: rec.parentID,
          model: rec.model,
          provider: rec.provider,
          contextWindow: rec.contextWindow,
          messageCount: rec.messageCount,
          state: rec.state,
          stateSince: rec.stateSince,
          sessionStart: rec.sessionStart,
          lastActivity: rec.lastActivity,
          lastError: rec.lastError,
          turns: rec.turns,
          steps: rec.steps,
          inputTokens: rec.inputTokens,
          outputTokens: rec.outputTokens,
          reasoningTokens: rec.reasoningTokens,
          cacheReadTokens: rec.cacheReadTokens,
          cacheWriteTokens: rec.cacheWriteTokens,
          lastMessageOutputTokens: rec.lastMessageOutputTokens,
          pendingApprovals: rec.pendingApprovals,
          errors: rec.errors,
          llmMs: rec.llmMs,
          userCalls: rec.userCalls,
          apiCalls: rec.apiCalls,
          stateMs: rec.stateMs,
          pid: rec.pid,
          tokSeries: rec.tokSeries,
          rateSeries: rec.rateSeries,
          version: "0.1.0",
          client: "dsh",
        })
      }
      const state = errored ? "error" : waiting ? "waiting" : running ? "running" : "idle"
      return { state, running, errored, waiting, instances }
    },
  }
}
