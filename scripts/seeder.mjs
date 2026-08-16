/**
 * Test seeder for dsh-obvious-grid: creates several realistic sessions
 * (including a sub-agent) through the real dsh-session service, so the
 * obvious-grid page has multiple cards to render. Loaded ONLY into an
 * isolated test profile — never in production.
 *
 * Shape: a cordis plugin row { name: <this file>, config: {} }.
 */
export const name = "obvious-grid-seeder"

const T0 = Date.now() - 90 * 60 * 1000

function usage(input, output, cacheRead, reasoning) {
  const u = { inputTokens: input, outputTokens: output }
  if (cacheRead > 0) u.cacheReadTokens = cacheRead
  if (reasoning > 0) u.reasoningTokens = reasoning
  return u
}

/** Append a realistic single turn: user msg -> steps with assistant messages. */
function appendTurn(session, turn, baseT, cwd, seedLen, opts) {
  const stepCount = opts?.steps ?? 2
  session.append("turn/start", { turn })
  session.append("user/message",
    { content: [{ type: "text", text: "help me with " + cwd }] },
    { surfaceOp: "append" })
  let seq = 0
  for (let s = 1; s <= stepCount; s++) {
    session.append("step/start", { turn, step: s })
    session.append("assistant/message",
      {
        turn,
        step: s,
        message: { role: "assistant", content: [{ type: "text", text: "done step " + s }] },
        usage: usage(1200 + seq * 80, 300 + seq * 40, 18000 + seq * 200, opts?.reasoning ? 40 + seq : 0),
      },
      { surfaceOp: "append" })
    session.append("step/end", { turn, step: s })
    seq++
  }
  session.append("turn/end", { turn })
  void baseT
  void seedLen
}

export function apply(ctx, config) {
  try {
  const sessions = ctx.sessions
  const create = (id, meta, turns) => {
    const session = sessions.create(id, { meta })
    session.append("session/title", { title: "seeded " + id, source: "user", messageSeqs: [] })
    session.append("request/context", {
      provider: "opencode-go",
      model: "deepseek-v4-flash",
      contextWindow: 1000000,
    })
    for (let t = 1; t <= turns; t++) appendTurn(session, t, T0, meta.cwd, 0, { reasoning: true })
    return session
  }

  // Parent session with a couple of turns.
  const parent = create("seed-parent-1", {
    cwd: "/home/qli/gitrepo/aof",
    createdAt: T0,
  }, 2)

  // Sub-agent of that parent (origin subagent + parentSession + depth 1).
  create("seed-sub-1", {
    cwd: "/home/qli/gitrepo/aof",
    parentSession: parent.id,
    origin: "subagent",
    delegationDepth: 1,
    createdAt: T0 + 10 * 60 * 1000,
  }, 1)

  // A second unrelated session, idle, no reasoning.
  const other = create("seed-other-1", {
    cwd: "/home/qli/gitrepo/bourse",
    createdAt: T0 + 20 * 60 * 1000,
  }, 1)

  // Park an approval on the parent so its card shows WAITING (blocked on you).
  parent.append("approval/asked", {
    kind: "permission",
    request: { permission: "bash", detail: "demo approval" },
  })

  ctx.logger?.info?.("obvious-grid-seeder: created 3 sessions")
  } catch (e) {
    ctx.logger?.warn?.("obvious-grid-seeder: seeding failed: " + String(e))
    console.error("obvious-grid-seeder FAILED:", e && e.stack ? e.stack : String(e))
  }
}
