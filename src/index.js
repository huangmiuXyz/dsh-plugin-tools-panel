/**
 * Tool guard, host half: a live, per-session, PER-TOOL kill-switch.
 *
 * WHAT THE SWITCH IS
 *   A session carries a DENY LIST of tool names. Nothing else: there are no kinds,
 *   no groups, and no built-in table of which tool belongs to which group. The list
 *   is edited by the composer control and read by this half on every call, so the
 *   next tool call already sees it — no reload, no restart, not even a re-render.
 *
 * TWO MECHANISMS, ON PURPOSE
 *   1. HIDING (`ctx.tools.restrict()` on the agent's own scope). A restricted tool
 *      disappears from the schemas the model is shown, so it is never offered in
 *      the first place. This is the primary mechanism: the model does not see the
 *      tool, so it does not call it, and the request is smaller.
 *      `restrict()` is scope-bound: the `tools` contract refuses an unscoped call
 *      ("would mask every agent"), so the restriction is applied by a tiny plugin
 *      mounted into `agent.ctx` — one per live agent. That plugin lives and dies
 *      with the agent's scope, which is also what removes the restriction.
 *   2. GUARDING (`ctx.tools.guard()`). A backstop, not the main path. `restrict()`
 *      only masks GLOBAL tools — a scope-local registration stays visible — and a
 *      scope whose mounting failed would otherwise be entirely unguarded. The guard
 *      is a SYNCHRONOUS monotonic check inside the pipeline that resolves the
 *      session's deny list on every call, so a name that slipped past hiding is
 *      still refused with a reason the model can read.
 *
 * WHY THE GUARD IS NOT THE PRIMARY MECHANISM ANY MORE
 *   A guard can only refuse a call that was already made. Before, the model kept
 *   seeing every tool and was told "do not retry" on each attempt; that burned a
 *   step per refusal. Hiding the tool removes that loop instead of describing it.
 *
 * SCOPE: ONE SESSION, PLUS WHAT IT SPAWNED
 *   A deny list is held by ONE session. Every agent descended from it resolves to
 *   the same list, so restricting a session restricts the subagents it delegates
 *   to; otherwise delegating would be a one-step way around the switch. Inheritance
 *   is resolved LAZILY at call time by walking the parent chain, so a child created
 *   later inherits with no extra work and releasing a parent releases every
 *   descendant at once.
 *
 *   The per-agent restriction is re-applied whenever the list changes (and when an
 *   agent is created), because a mounted scope does not re-read anything by itself.
 *
 *   A call with NO agent is not governed: it has no session to carry a list, so
 *   there is nothing the user could have switched off for it.
 *
 * WHAT POPULATES THE LIST
 *   The control lists the tools the session can actually see, read from the
 *   registry (`ctx.tools.schemas(agent)`) at the moment the menu opens. Nothing is
 *   hard-coded here: an MCP server or a third-party plugin that registers a tool
 *   shows up in the menu by itself, and uninstalls disappear from it. The names
 *   that are currently denied are always listed too, even though hiding made them
 *   invisible to `schemas()` — otherwise a denied tool could never be re-enabled.
 *
 * PERSISTENCE
 *   Deny lists live in this process's memory only. A DSH restart clears every
 *   switch back to "nothing denied". That is deliberate for a panic switch — a
 *   restriction the user forgot about should not survive a restart — but it does
 *   mean the switch is not durable configuration.
 *
 * GROUPS (added in protocol 7)
 *   A user can name a set of tools and get one row for it. Groups are
 *   PRESENTATION AND BULK ACTION ONLY: a group has no policy of its own, so the
 *   truth is still per-tool. Turning a group off denies its members; turning it
 *   back on allows them. A tool may belong to several groups, which is why the
 *   group row's switch is derived (all members denied? then it reads off) rather
 *   than stored.
 *
 *   Group definitions are DURABLE and global (one file under `DSH_HOME`), because
 *   they are the user's organization of their own tool list, not a restriction on
 *   one conversation. The deny list stays per-session and in memory.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Control route the client half reads and writes. Namespaced so it cannot collide. */
const ROUTE = '/dsh-plugin-tools-panel/state'
/**
 * Header the client must send on a state change. A cross-origin page can POST a
 * "simple" request without a preflight, so requiring a custom header is what
 * actually forces one — the browser then blocks the call because this server
 * answers no CORS preflight. Same-origin callers (our own client half) are
 * unaffected.
 */
const HEADER = 'x-dsh-plugin-tools-panel'
/**
 * Wire version of the control route, shared with the client half.
 *
 * The two halves are loaded independently: a browser bundle hot-reloads on save,
 * while this Node-side module keeps running the code it was mounted with until the
 * process restarts. So a saved edit routinely produces a NEW client talking to an
 * OLD host.
 *
 * Without this marker that mismatch is silent and looks like a bug in the switch:
 * the client posts `deny`, the old host only knows `allowRead`/`allowWrite`, ignores
 * the unknown field, and answers with its unchanged state — so the switch springs
 * back a moment after the click. Numbering the protocol turns that into a stated
 * fact: a client that does not see its own version says the host is stale and asks
 * for a restart.
 *
 * HISTORY: 5 was the four-group revision (read/write/shell/agent). 6 replaced the
 * groups with a per-tool deny list, so the whole state shape changed. 7 added
 * user-defined GROUPS (a persisted, presentation-only grouping of tool names), so
 * the snapshot grew a `groups` field and a POST may carry one.
 */
const PROTOCOL = 7

/**
 * Where the user's own group definitions live.
 *
 * Groups are NOT session state: they are the user's organization of their tool
 * list, so they are global and durable, unlike the deny list (per session, memory
 * only — a panic switch must not survive a restart). A group is a name plus member
 * names; a tool may sit in several groups, and a group's switch is only a bulk
 * action over its members' deny state.
 *
 * `DSH_HOME` is set in every profile-launched process; the homedir fallback keeps a
 * bare `dsh` invocation from writing to `/`.
 */
function groupsFile() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'dsh-plugin-tools-panel', 'groups.json')
}

/**
 * Read the saved groups.
 *
 * A missing file is "no groups yet", not an error, and a corrupt one is treated the
 * same way rather than throwing: losing the grouping must never take the plugin —
 * and therefore the kill switch — down with it.
 * @returns `{ id, name, members }[]`.
 */
function loadGroups() {
  try {
    const parsed = JSON.parse(readFileSync(groupsFile(), 'utf8'))
    return normalizeGroups(parsed?.groups)
  } catch {
    return []
  }
}

/** Persist the groups, atomically enough that a crash cannot truncate the file. */
function saveGroups(groups) {
  try {
    const file = groupsFile()
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.tmp-${process.pid}`
    writeFileSync(temp, `${JSON.stringify({ version: 1, groups }, null, 2)}\n`, 'utf8')
    renameSync(temp, file)
  } catch {
    // A read-only home leaves the groups in memory for this process: degraded, but
    // the switch keeps working, which is the part that matters.
  }
}

/**
 * Validate and normalize a groups payload.
 *
 * Ids are assigned here when absent, so the client can send `{ name, members }` for
 * a new group without inventing an identity. Everything is bounded: this payload
 * comes from a browser over an HTTP route.
 * @returns the cleaned array, or undefined when the shape is unusable.
 */
function normalizeGroups(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined
  if (value.length > MAX_GROUPS) return undefined
  const groups = []
  const seen = new Set()
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, MAX_GROUP_NAME) : ''
    if (name.length === 0) continue
    const members = []
    const dedupe = new Set()
    if (Array.isArray(entry.members)) {
      for (const member of entry.members) {
        if (typeof member !== 'string') continue
        const tool = member.trim()
        if (tool.length === 0 || tool.length > MAX_NAME || dedupe.has(tool)) continue
        dedupe.add(tool)
        members.push(tool)
        if (members.length >= MAX_TOOLS) break
      }
    }
    let id = typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 64 ? entry.id : undefined
    if (id === undefined || seen.has(id)) id = `g${groups.length + 1}-${Math.random().toString(36).slice(2, 8)}`
    seen.add(id)
    groups.push({ id, name, members })
  }
  return groups
}

/**
 * Bounds on what one request may carry. The control sends at most the tools the
 * session can see, which is a few hundred even with several MCP servers; these are
 * guard rails against a malformed or hostile body, not product limits.
 */
const MAX_TOOLS = 1000
const MAX_NAME = 200
/** How many user-defined groups one profile may hold, and how long a name may be. */
const MAX_GROUPS = 100
const MAX_GROUP_NAME = 60

/**
 * The live switch, per session.
 *
 * A session appears here only once something is denied; absence means every tool
 * is allowed. `blocked` and `last` are diagnostics: they distinguish a restriction
 * that is working from one that was configured but never fired. The control does
 * not print them, but they stay on the snapshot because reading one JSON response
 * is the fastest way to answer "is this guard actually running" — and because a
 * NAME that had to fall back to the guard (a scope-local tool that `restrict()`
 * cannot mask) shows up there rather than disappearing silently.
 */
const policies = new Map()

/**
 * The user's group definitions, loaded once at module load and written back on every
 * change. Global, not per session: see the header's GROUPS section.
 */
let groups = loadGroups()

/**
 * Who spawned whom, for every live agent — restricted or not.
 *
 * Separate from `policies` on purpose: a link must be recorded even while both
 * ends are unrestricted, because a session can be restricted LATER, and by then
 * the cheapest moment to answer "who is the parent" has already passed.
 */
const parents = new Map()

/** A session with no policy at all. Shared, because it must never be mutated. */
const EMPTY_DENY = new Set()

/**
 * The session whose policy governs one session: itself, or its nearest restricted
 * ancestor.
 *
 * Walking up rather than copying a policy down is what makes restriction behave as
 * one unit across a delegation tree — a parent restricted after a child was
 * created still governs that child, and releasing the parent releases every
 * descendant that had no restriction of its own.
 *
 * The `seen` guard is not defensive padding: a cycle would hang the GUARD, which
 * runs synchronously inside the tool pipeline where a hang cannot be timed out.
 * @param table - the policy map to read.
 * @param tree - the child→parent map.
 * @param sessionId - the session asking.
 * @returns the id of the session that holds the applicable policy.
 */
function ownerIn(table, tree, sessionId) {
  let current = sessionId
  const seen = new Set()
  while (typeof current === 'string' && !seen.has(current)) {
    if (table.has(current)) return current
    seen.add(current)
    current = tree.get(current)
  }
  // Nobody above holds a policy. This session is the one that will hold the next
  // edit, so it is its own owner.
  return sessionId
}

/** `ownerIn` over the live tables. */
function ownerOf(sessionId) {
  return ownerIn(policies, parents, sessionId)
}

/** The effective policy for one session, whether held by it or inherited. */
function policyFor(sessionId) {
  return policies.get(ownerOf(sessionId))
}

/** The exact set of denied names that governs one session (never mutated here). */
function denySetFor(sessionId) {
  return policyFor(sessionId)?.deny ?? EMPTY_DENY
}

/**
 * The reason the model receives when a denied tool reaches dispatch anyway.
 *
 * This string is the WHOLE message: it lands in `ToolFailure.message` and in the
 * call's rendered content, so it has to answer the model's three questions at
 * once — what happened, whether to retry, and what to do instead. It says "do not
 * retry" explicitly because a model that reads a bare refusal tends to retry it,
 * which burns a step and reads to the user as the switch not working.
 *
 * Normal path: the control already HID the tool, so this message is what the model
 * sees only for a name that hiding could not mask.
 * @param name - the refused tool name.
 * @returns the denial reason.
 */
function denyReason(name) {
  return (
    `此操作已被用户实时禁用：工具「${name}」未执行，且不要再尝试调用。` +
    `This tool is disabled live by the user: "${name}" was not executed. ` +
    `Do not retry it — continue with what the user allows, or tell the user what you need.`
  )
}

/**
 * Build the synchronous guard over one live policy table.
 *
 * A factory rather than a module-level function so the guard reads the same table
 * the HTTP handler mutates, and so a test can drive an isolated copy.
 * @param table - the policy map to read.
 * @param tree - the child→parent map used to resolve inheritance.
 * @returns the guard, in the `ctx.tools.guard()` shape.
 */
function makeGuard(table, tree) {
  return function guard(exec) {
    const sessionId = exec.agent?.id
    // No agent means no session to carry a list: nothing was switched off for this
    // call, so it is out of scope rather than implicitly denied.
    if (typeof sessionId !== 'string') return undefined
    // Resolve the owner ONCE and reuse it: the walk runs inside the pipeline, and
    // asking for the owner twice per call is work with no second answer.
    const ownerId = ownerIn(table, tree, sessionId)
    const record = table.get(ownerId)
    if (record === undefined || !record.deny.has(exec.name)) return undefined
    record.blocked += 1
    record.last = { tool: exec.name, at: new Date().toISOString(), sessionId }
    return denyReason(exec.name)
  }
}

// --- per-agent hiding ---------------------------------------------------------

/**
 * Mount a deny list into agent scopes and keep it in step with the policy table.
 *
 * The `tools` contract refuses an unscoped `restrict()` — a process-wide mask over
 * every agent is not what a per-session switch means — so the only supported way is
 * to register the restriction from a context that IS scoped to the agent. Cordis
 * calls that mounting a fiber into `agent.ctx`; the fiber is owned by the agent
 * scope, so the restriction is removed when the agent goes away.
 *
 * The mounted plugin is deliberately tiny and dumb: it holds one applied signature,
 * re-reads the wanted set from this controller when asked, and does nothing else.
 * All of the policy/inheritance logic stays in one place (the table above) instead
 * of being duplicated into N live agent scopes.
 * @param scope - the plugin context (needs `tools`; provides `schemas`).
 * @returns the controller used by the route and by the agent lifecycle listeners.
 */
function createRestrictor(scope) {
  /** agentId -> { holder, fiber } */
  const entries = new Map()
  let live = true
  let timer
  /** Why the last mount attempt failed, for the snapshot's diagnostics. */
  let mountError
  /** The last `restrict()` failure, for the snapshot's diagnostics. */
  let restrictError

  /**
   * Names the registry currently holds GLOBALLY, or undefined when it cannot say.
   *
   * `restrict()` throws for a name it does not know ("unknown global tool"), and it
   * only masks global tools — a scope-local registration stays visible. Intersecting
   * the deny list with this set before applying is therefore both what keeps the
   * call from throwing and what documents the boundary: a name that is not here is
   * left to the guard.
   *
   * `undefined` is not "no tools": a registry that cannot answer must leave the
   * restriction it already applied alone, because clearing it would turn a
   * momentary read failure into a tool the user switched off becoming callable.
   */
  function knownGlobalNames() {
    try {
      return new Set(scope.tools.schemas().map((schema) => schema.name))
    } catch {
      return undefined
    }
  }

  /**
   * The deny list that applies to one agent, cut down to names hiding can mask.
   * @param agentId - the session whose policy applies (after inheritance).
   * @param known - the global names, or undefined when they are unavailable.
   * @returns the names to mask, or undefined to leave the applied set untouched.
   */
  function wantedFor(agentId, known) {
    if (known === undefined) return undefined
    const deny = denySetFor(agentId)
    if (deny.size === 0) return []
    return [...deny].filter((name) => known.has(name)).sort()
  }

  /** Mount one agent's restriction plugin, if that agent exposes a scope. */
  function mount(agent) {
    if (!live) return
    const id = agent?.id
    if (typeof id !== 'string' || entries.has(id)) return
    // `agent.ctx` is not part of the published Agent interface, so its absence is
    // ordinary (an older registry). The guard still enforces; only hiding is lost.
    const agentScope = agent.ctx
    if (agentScope === undefined || typeof agentScope.plugin !== 'function') {
      mountError = 'agent has no ctx.plugin (older registry): hiding unavailable'
      return
    }

    // Filled in by `apply` below: the controller only ever calls `sync`.
    const holder = { sync: () => {} }
    const plugin = {
      name: 'dsh-plugin-tools-panel:restricted-tools',
      inject: ['tools'],
      apply(c) {
        let stopped = false
        let applied = null
        const disposers = []

        const clear = () => {
          for (const off of disposers.splice(0)) {
            try {
              off()
            } catch {
              // A layer already dropped with the registry: nothing left to undo.
            }
          }
        }

        /**
         * Re-apply this agent's restriction.
         * @param known - the global names, when the caller already computed them for
         * a whole pass. Omitted on the initial mount, where there is no shared pass.
         */
        const sync = (known) => {
          if (stopped) return
          const names = wantedFor(id, known ?? knownGlobalNames())
          // No answer from the registry: keep whatever is applied. Clearing here
          // would make a tool the user switched off callable again.
          if (names === undefined) return
          const signature = names.join('\u0000')
          // Re-applying an unchanged set would tear down and rebuild the same
          // layers, and `restrict()`/its disposer each emit `tools/change`
          // synchronously — so an unchanged set is genuinely a no-op, not an
          // optimisation. That is also what keeps the nested `tools/change` a
          // runaway `restrict()` triggers from recursing: see `applied` below.
          if (signature === applied) return
          // Claimed BEFORE the first restriction is applied. `restrict()` emits
          // `tools/change` on the way in, and this very function is what that event
          // re-enters through; claiming first makes the re-entrant pass see the new
          // signature and return instead of tearing the layers down mid-apply.
          applied = signature
          clear()
          if (names.length === 0) return
          try {
            disposers.push(c.tools.restrict({ deny: names }))
            restrictError = undefined
            return
          } catch (error) {
            // One unacceptable name (a reserved transport name, a name registered
            // after `knownGlobalNames()` ran) must not take the whole restriction
            // down: apply the rest one layer at a time and keep what sticks. The
            // signature stays claimed, so a fixed property of a name — being
            // reserved — is not retried on every tool change; the guard covers it.
            restrictError = String(error?.message ?? error)
          }
          for (const name of names) {
            try {
              disposers.push(c.tools.restrict({ deny: [name] }))
            } catch {
              // Not maskable from this scope; the guard covers it.
            }
          }
        }

        holder.sync = sync
        try {
          c.effect(() => () => {
            stopped = true
            clear()
            holder.sync = () => {}
          })
        } catch {
          // A minimal context without `effect`: the fiber teardown still runs.
        }
        sync()
      }
    }

    try {
      // The holder object is stable: the mounted fiber swaps `sync` in place, and the
      // controller reaches it through this map.
      entries.set(id, { holder, fiber: agentScope.plugin(plugin) })
      mountError = undefined
    } catch (error) {
      // The scope died between listing and mounting. Leave it to the guard, but say
      // so in the snapshot: a silently un-hidden session is exactly the failure a
      // user cannot diagnose from the UI.
      mountError = String(error?.message ?? error)
    }
  }

  /** Re-read the policy for every mounted agent. */
  function syncAll() {
    if (!live) return
    // One registry read for the whole pass, not one per agent: the global name set
    // is the same question for all of them.
    const known = knownGlobalNames()
    if (known === undefined) return
    for (const entry of entries.values()) {
      try {
        entry.holder.sync(known)
      } catch {
        // A throwing scope must not stop the other agents from being updated.
      }
    }
  }

  /**
   * Mount every agent that already exists.
   *
   * `agent/created` covers agents born after this plugin mounted; this covers the
   * ones already live when it did (a profile reload while sessions are open), so a
   * deny list set before the reload still hides its tools afterwards.
   * @param list - the live agents.
   */
  function mountAll(list) {
    for (const agent of list ?? []) mount(agent)
  }

  /**
   * Re-apply on the NEXT tick, at most once.
   *
   * `restrict()` and its disposer emit `tools/change` synchronously, so re-applying
   * from inside that emission recurses through the registry. Deferring one tick
   * breaks the cycle; the signature check inside `sync()` then makes the pass a
   * no-op when nothing actually changed.
   */
  function scheduleSync() {
    if (!live || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      syncAll()
    }, 0)
    // A pending retry must not keep the process alive on its own.
    timer?.unref?.()
  }

  /** Forget one agent. The restriction itself was owned by its scope. */
  function release(id) {
    entries.delete(id)
  }

  function dispose() {
    live = false
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    for (const entry of entries.values()) {
      try {
        entry.fiber?.dispose?.()
      } catch {
        // The scope is already gone; there is nothing left to dispose.
      }
    }
    entries.clear()
  }

  return {
    mount,
    mountAll,
    syncAll,
    scheduleSync,
    release,
    dispose,
    get size() { return entries.size },
    get error() { return mountError ?? restrictError }
  }
}

// --- http ---------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // The control polls this; a cached answer would show a stale switch.
    'cache-control': 'no-store'
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 100000) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

/** A session id as it may appear in a query string or a JSON body. */
function cleanSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined
}

/**
 * Normalize an incoming deny list, or `undefined` when the shape is unusable.
 *
 * Trimmed, deduplicated, bounded. Names are NOT validated against the registry:
 * a name the user denied must survive a moment when that tool is not registered
 * (an MCP server reconnecting), or the switch would silently forget it.
 * @returns the cleaned array, or undefined for a non-array payload.
 */
function cleanDeny(value) {
  if (!Array.isArray(value)) return undefined
  if (value.length > MAX_TOOLS) return undefined
  const names = []
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const name = entry.trim()
    if (name.length === 0 || name.length > MAX_NAME || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

/**
 * Tool names the session can see, plus every name it has denied.
 *
 * `schemas(agent)` is the honest answer to "what can this conversation call", and
 * it is what makes the menu follow the real composition: a preset that mounts
 * fewer tools shows fewer rows, an MCP server that connects adds rows.
 *
 * The denied names are unioned in because hiding is exactly what removes them from
 * that answer — without the union the control could only ever switch tools OFF.
 *
 * NO FALLBACK TO THE GLOBAL VIEW. This used to fall back to `schemas()` when the
 * session had no live agent, and that was wrong in the one case it mattered most: a
 * tool-less preset ("空白模式") has no visible tools, so the menu listed all 51
 * process-wide tools — offering switches for tools that session can never call. An
 * empty answer is the truthful answer; the menu shows "no tools" instead of
 * inventing rows.
 * @param sessionId - the conversation's session.
 * @param host - `{ tools, agents }`.
 * @returns the sorted union of the session's visible tools and its denied names.
 */
function toolsForSession(sessionId, host) {
  const visible = []
  const agent = host.agents?.get?.(sessionId)
  if (agent !== undefined) {
    try {
      for (const schema of host.tools.schemas(agent)) visible.push(schema.name)
    } catch {
      /* a registry that cannot answer leaves the denied names below */
    }
  }
  return [...new Set([...visible, ...denySetFor(sessionId)])].sort()
}

/**
 * How many of the session's denied names the registry no longer offers to it.
 *
 * This is the ONLY observable difference between "hidden" and "merely guarded": a
 * name that is denied but still in `schemas(agent)` was not masked (a scope-local
 * tool, a failed mount) and is being stopped by the guard alone. Reading it from the
 * snapshot is what makes that distinction answerable without a debugger.
 */
function maskedCount(sessionId, host) {
  const denied = denySetFor(sessionId)
  if (denied.size === 0) return 0
  const agent = host.agents?.get?.(sessionId)
  if (agent === undefined) return 0
  try {
    const visible = new Set(host.tools.schemas(agent).map((schema) => schema.name))
    let masked = 0
    for (const name of denied) if (!visible.has(name)) masked += 1
    return masked
  } catch {
    return 0
  }
}

/**
 * The snapshot the control renders for ONE session.
 *
 * `ownerId` is sent because the control needs to say when a list it is showing is
 * actually held by an ancestor: without that, a subagent's menu would look like the
 * place the restriction was set.
 */
function snapshot(sessionId, host) {
  const ownerId = ownerOf(sessionId)
  const record = policies.get(ownerId)
  return {
    protocol: PROTOCOL,
    sessionId,
    ownerId,
    inherited: ownerId !== sessionId,
    tools: host === undefined ? [...(record?.deny ?? [])].sort() : toolsForSession(sessionId, host),
    denied: record === undefined ? [] : [...record.deny].sort(),
    // Diagnostics, not UI: how many agent scopes currently carry a restriction (so
    // "is hiding mounted at all" is one JSON read), why the last mount/apply failed,
    // and how many denied names are really gone from the model's schema list.
    scopes: host?.restrictor?.size ?? 0,
    ...(host?.restrictor?.error === undefined ? {} : { scopesError: host.restrictor.error }),
    masked: host === undefined ? undefined : maskedCount(sessionId, host),
    // The user's groups, copied so a caller cannot mutate the live definitions.
    groups: groups.map((group) => ({ id: group.id, name: group.name, members: [...group.members] })),
    blocked: record?.blocked ?? 0,
    last: record?.last
  }
}

/**
 * Write one session's deny list, then re-apply hiding to every live agent.
 *
 * The list is replaced wholesale rather than patched per name: the control already
 * knows the complete set, a whole-list write is idempotent, and two windows racing
 * on one name cannot leave a half-updated list behind.
 */
function setDeny(sessionId, names, restrictor) {
  const ownerId = ownerOf(sessionId)
  const current = policies.get(ownerId)
  if (names.length === 0) {
    // Nothing is denied, so there is no policy to hold. Dropping the entry is what
    // lets a later-created descendant inherit "allowed" by simple absence.
    policies.delete(ownerId)
  } else {
    policies.set(ownerId, {
      deny: new Set(names),
      blocked: current?.blocked ?? 0,
      last: current?.last
    })
  }
  restrictor?.syncAll()
}

/**
 * Serve the control route.
 *
 * GET reads one session's list; POST replaces it. Only `deny` is accepted, so a
 * malformed or hostile payload can do nothing beyond the same edit the control
 * offers.
 */
async function handleState(req, res, host) {
  const url = new URL(req.url ?? ROUTE, 'http://localhost')
  if (req.method === 'GET') {
    const sessionId = cleanSessionId(url.searchParams.get('sessionId'))
    if (sessionId === undefined) {
      sendJson(res, 400, { ok: false, error: 'missing sessionId query parameter' })
      return
    }
    sendJson(res, 200, { ok: true, state: snapshot(sessionId, host) })
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  if (req.headers?.[HEADER] === undefined) {
    sendJson(res, 403, { ok: false, error: `missing ${HEADER} header` })
    return
  }
  let payload = {}
  try {
    const body = await readBody(req)
    if (body) payload = JSON.parse(body)
  } catch {
    sendJson(res, 400, { ok: false, error: 'bad json body' })
    return
  }
  if (payload === null || typeof payload !== 'object') {
    sendJson(res, 400, { ok: false, error: 'bad json body' })
    return
  }
  const sessionId = cleanSessionId(payload.sessionId)
  if (sessionId === undefined) {
    sendJson(res, 400, { ok: false, error: 'missing sessionId in the request body' })
    return
  }
  // A body that carries NEITHER field is not a no-op to shrug off: it means the
  // caller and this host disagree about the protocol (a hot-reloaded client against
  // a host that predates the per-tool list, say). Answering `ok` with unchanged
  // state is what made that mismatch look like a switch that springs back on its
  // own, so say so instead.
  const hasDeny = Object.prototype.hasOwnProperty.call(payload, 'deny')
  const hasGroups = Object.prototype.hasOwnProperty.call(payload, 'groups')
  if (!hasDeny && !hasGroups) {
    sendJson(res, 409, {
      ok: false,
      error:
        `this host speaks tools-panel protocol ${PROTOCOL} and recognizes neither ` +
        `\`deny\` nor \`groups\`; it is probably running older code than the page — restart DSH`
    })
    return
  }
  if (hasGroups) {
    // Groups are global, but the request still names a session: that is the
    // conversation the control is showing, and its snapshot comes back below.
    if (replaceGroups(payload.groups) === undefined) {
      sendJson(res, 400, { ok: false, error: '`groups` must be an array' })
      return
    }
  }
  if (hasDeny) {
    const names = cleanDeny(payload.deny)
    if (names === undefined) {
      sendJson(res, 400, { ok: false, error: '`deny` must be an array of tool names' })
      return
    }
    // The edit lands on the session that OWNS the policy, not necessarily the one
    // that asked. A subagent showing an inherited list must be able to release it,
    // and releasing it for the whole tree is what the user means by "this session".
    setDeny(sessionId, names, host.restrictor)
  }
  sendJson(res, 200, { ok: true, state: snapshot(sessionId, host) })
}

/**
 * Register the control route.
 *
 * `webServer` is optional — a terminal-only profile never provides it — so when it
 * is absent the route is registered if and when the service appears, instead of
 * holding the plugin's own activation open on a service that will never come. The
 * guard itself is registered unconditionally: it needs `tools` only, and a
 * deployment without a browser still wants the switch honoured for whatever edits
 * the list (a UI-less caller can still POST to the route once it appears).
 */
function registerRoute(scope, host, deps) {
  scope.effect(
    () => host.register({ kind: 'exact', path: ROUTE, handler: (req, res) => handleState(req, res, deps) }),
    'tools-panel: control route'
  )
}

/**
 * Record who spawned one agent, so a restriction can reach it later.
 *
 * `isOwnedBy` is the authoritative answer and needs no assumption about listener
 * ordering or about a causal-parent ambient being in scope at this moment. Scanning
 * every live agent is O(live agents) and runs once per creation, which is the
 * cheapest reliable way to ask the registry a question it answers per candidate.
 *
 * A failure here is swallowed into "no known parent": the consequence is that a
 * restriction may not reach that one child, which is strictly better than failing
 * agent creation.
 * @returns the parent's id, or undefined for a top-level agent.
 */
function detectParent(agents, child) {
  try {
    for (const candidate of agents.list()) {
      if (candidate.id === child.id) continue
      if (agents.isOwnedBy(child.id, candidate)) return candidate.id
    }
  } catch {
    /* an older registry without isOwnedBy: leave the tree flat */
  }
  return undefined
}

/**
 * Services required before `apply` may run.
 *
 * `tools` is a hard dependency: the guard IS the feature, so a deployment without
 * the registry should keep this plugin inactive rather than half-mounted. `agents`
 * is NOT listed: the guard scopes itself from `exec.agent` and works without any
 * registry, so an `inject` edge on it would take the whole feature down on a
 * deployment that happened not to provide it — only inheritance and hiding would be
 * lost.
 */
export const inject = ['tools']

export function apply(ctx) {
  // Hiding needs `tools` (restrict/schemas) and each agent's scope; the controller
  // takes the plugin's own context so it can read the GLOBAL schema view.
  const restrictor = createRestrictor(ctx)
  ctx.effect(() => () => restrictor.dispose(), 'tools-panel: restriction scopes')

  ctx.effect(() => ctx.tools.guard(makeGuard(policies, parents)), 'tools-panel: live guard')

  // Record the delegation tree and mount one restriction per live agent. Both
  // listeners are registered through the same optional-service probe, so a
  // deployment without `agents` keeps the guard and simply has a flat tree.
  const agents = ctx.get('agents')
  if (agents !== undefined) {
    ctx.effect(
      () => ctx.on('agent/created', ({ agent }) => {
        const parentId = detectParent(agents, agent)
        if (parentId !== undefined) parents.set(agent.id, parentId)
        // Mount at creation so a switch set BEFORE the child existed already covers
        // it; the lazy walk decides what that switch means for this child.
        restrictor.mount(agent)
      }),
      'tools-panel: delegation tree'
    )
    ctx.effect(
      () => ctx.on('agent/disposed', ({ agent }) => {
        // The LINK goes, the POLICY stays: the restriction is an explicit user
        // decision about a session, and a session that closes and resumes later
        // should still be restricted. Keeping the link would instead keep a
        // finished child in the walk forever.
        parents.delete(agent.id)
        // The restriction itself was owned by the agent scope and is already gone.
        restrictor.release(agent.id)
      }),
      'tools-panel: tree cleanup'
    )
    restrictor.mountAll(agents.list())
  }

  // A tool that appears after the switch was set (an MCP server connecting) must be
  // hidden for sessions that already deny it. Deferred, so `restrict()`'s own
  // synchronous `tools/change` cannot recurse through this listener.
  ctx.effect(() => ctx.on('tools/change', () => restrictor.scheduleSync()), 'tools-panel: tool set changes')

  const deps = { tools: ctx.tools, agents, restrictor }
  const server = ctx.get('webServer')
  if (server !== undefined) registerRoute(ctx, server, deps)
  else ctx.inject(['webServer'], (scope) => registerRoute(scope, scope.webServer, deps))
}

export {
  EMPTY_DENY,
  HEADER,
  MAX_GROUP_NAME,
  MAX_GROUPS,
  MAX_NAME,
  MAX_TOOLS,
  PROTOCOL,
  ROUTE,
  cleanDeny,
  createRestrictor,
  denyReason,
  denySetFor,
  groupsFile,
  loadGroups,
  makeGuard,
  normalizeGroups,
  ownerOf,
  parents,
  policies,
  policyFor,
  saveGroups,
  setDeny,
  snapshot,
  toolsForSession
}

/** The live group definitions (read-only view; the route replaces the array). */
export function getGroups() {
  return groups
}

/**
 * Validate, store and persist a new group list.
 *
 * The ONE write path, shared by the control route and the `manage_tool_groups`
 * tool: two callers, two chances to forget the save, so the save lives here.
 * @returns the normalized list that is now live, or undefined when the payload is
 *   unusable (in which case nothing changed).
 */
export function replaceGroups(value) {
  const next = normalizeGroups(value)
  if (next === undefined) return undefined
  groups = next
  saveGroups(groups)
  return groups
}

/** Test-only: replace the live group definitions without touching disk. */
export function setGroups(next) {
  groups = next
}
