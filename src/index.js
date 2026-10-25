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
 *   1. HIDING (`ctx.tools.restrict()` on the scopes that hold the tools). A
 *      restricted tool disappears from the schemas the model is shown, so it is never
 *      offered in the first place. This is the primary mechanism: the model does not
 *      see the tool, so it does not call it, and the request is smaller.
 *      `restrict()` is scope-bound: the `tools` contract refuses an unscoped call
 *      ("would mask every agent"), so the restriction is applied by a tiny plugin
 *      mounted into a scope — the agent's own `agent.ctx` AND every scope above it.
 *      That chain walk is load-bearing, not defensive: a PRESET registers its tool
 *      rows into its OWN layer, which is an ancestor of the agent, and only a
 *      restriction registered on the layer that HOLDS a tool can mask it. Mounting
 *      on the agent alone left every preset tool visible while the panel showed its
 *      switch as off. Each mounted plugin lives and dies with its scope, which is
 *      also what removes the restriction.
 *   2. GUARDING (`ctx.tools.guard()`). A backstop, not the main path. `restrict()`
 *      only masks INHERITED contributions — a scope's OWN registrations stay visible
 *      — and a scope whose mounting failed would otherwise be entirely unguarded.
 *      The guard is a SYNCHRONOUS monotonic check inside the pipeline that resolves
 *      the session's deny list on every call, so a name that slipped past hiding is
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

import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Control route the client half reads and writes. Namespaced so it cannot collide. */
const ROUTE = '/dsh-plugin-tools-panel/state'
/** The skills tab's route: list the session's skills, toggle one model invocation. */
const SKILLS_ROUTE = '/dsh-plugin-tools-panel/skills'
/** The prompt tab's route: list the assembled system prompt sections, toggle one. */
const PROMPTS_ROUTE = '/dsh-plugin-tools-panel/prompts'
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
 * the snapshot grew a `groups` field and a POST may carry one. 8 added the SKILLS
 * and PROMPTS routes: a skill toggle rewrites `disable-model-invocation` in the
 * skill file, and a prompt toggle persists a disabled section name that is
 * shadowed by an empty same-name section in every live agent's scope.
 */
const PROTOCOL = 8

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

// --- skills and prompt sections (protocol 8) ----------------------------------

/** How much of one prompt section the browser receives for its preview. */
const MAX_SECTION_TEXT = 4000
/** How much of one skill description the browser receives. */
const MAX_SKILL_DESCRIPTION = 1000
/** How many disabled section names one profile may hold. */
const MAX_PROMPTS = 200
/** Bound on the remembered section texts, so a long-lived process cannot grow forever. */
const MAX_SECTION_CACHE = 500

/**
 * Where the disabled prompt sections live.
 *
 * Same shape and same reasoning as {@link groupsFile}: the switch is the user's
 * configuration of their own prompt, not a restriction on one conversation, so it
 * is global and durable. A section name is the whole identity — there is no id to
 * keep stable across a plugin reload.
 */
function promptsFile() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'dsh-plugin-tools-panel', 'prompts.json')
}

/**
 * Validate and normalize a disabled-section list.
 *
 * Bounded like every other payload that can arrive over the route. Invalid entries
 * are dropped rather than rejected wholesale: a corrupt file must degrade to "no
 * sections disabled", never take the plugin down.
 * @returns a deduplicated array of section names.
 */
function normalizePromptNames(value) {
  if (!Array.isArray(value)) return []
  const names = []
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const name = entry.trim()
    if (name.length === 0 || name.length > MAX_NAME || seen.has(name)) continue
    seen.add(name)
    names.push(name)
    if (names.length >= MAX_PROMPTS) break
  }
  return names
}

/** Read the saved disabled-section names; a missing or corrupt file means none. */
function loadPrompts() {
  try {
    const parsed = JSON.parse(readFileSync(promptsFile(), 'utf8'))
    return normalizePromptNames(parsed?.disabled)
  } catch {
    return []
  }
}

/** Persist the disabled-section names atomically enough that a crash cannot truncate. */
function savePrompts(names) {
  try {
    const file = promptsFile()
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.tmp-${process.pid}`
    writeFileSync(temp, `${JSON.stringify({ version: 1, disabled: [...names] }, null, 2)}\n`, 'utf8')
    renameSync(temp, file)
  } catch {
    // A read-only home leaves the switch in memory for this process: degraded, but
    // the panel keeps working, which is the part that matters.
  }
}

/** The live disabled set, loaded once at module load and written on every change. */
let promptDisabled = new Set(loadPrompts())

/** The last non-empty text seen for one section name, so a disabled row still previews. */
const lastSectionText = new Map()

/** Remember one section's text for the disabled-row preview. */
function noteSectionText(name, text) {
  if (text.length === 0) return
  if (!lastSectionText.has(name) && lastSectionText.size >= MAX_SECTION_CACHE) return
  lastSectionText.set(name, text)
}

/** A bounded preview plus the fact that it was cut. */
function truncateText(value, max) {
  const text = String(value ?? '')
  return text.length > max
    ? { text: `${text.slice(0, max - 1)}…`, truncated: true }
    : { text, truncated: false }
}

/**
 * Add or replace `disable-model-invocation` in a skill's YAML frontmatter.
 *
 * Deliberately NOT a YAML round-trip: a skill file is hand-written prose plus a
 * small frontmatter block, and re-serializing it would reformat the user's file
 * (comments, quoting, key order). This edits exactly one top-level key, keeps the
 * document's line endings and any BOM, and refuses a file without a closed block
 * rather than guessing.
 * @param text - the file's full text.
 * @param enabled - whether the model should see the skill (true = visible).
 * @returns the new text, or undefined when the frontmatter is unusable.
 */
function patchSkillFrontmatter(text, enabled) {
  // The KEY is the negation: hiding a skill means writing `disable-model-invocation: true`.
  const value = enabled ? 'false' : 'true'
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''
  const body = bom.length > 0 ? text.slice(1) : text
  const newline = body.includes('\r\n') ? '\r\n' : '\n'
  const lines = body.split(/\r?\n/)
  if (lines.length < 3 || lines[0].trim() !== '---') return undefined
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      end = index
      break
    }
  }
  if (end < 0) return undefined
  const key = /^disable-model-invocation[ \t]*:/
  let found = -1
  for (let index = 1; index < end; index += 1) {
    if (key.test(lines[index])) {
      found = index
      break
    }
  }
  if (found >= 0) {
    lines[found] = lines[found].replace(
      /^(disable-model-invocation[ \t]*:)[ \t]*.*$/,
      `$1 ${value}`
    )
  } else {
    lines.splice(end, 0, `disable-model-invocation: ${value}`)
  }
  return `${bom}${lines.join(newline)}`
}

/** Write a file through a same-directory temp + rename, so a reader never sees a half file. */
function writeFileAtomic(path, content) {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(temp, content, 'utf8')
    renameSync(temp, path)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      /* the temp file was never created, or is already gone */
    }
    throw error
  }
}

/**
 * A refusal this route can explain to the browser.
 *
 * `status` is carried rather than inferred so "unknown skill" (404), "no file to
 * edit" (409) and "the service is missing" (409) are distinguishable on the wire —
 * the client uses that difference to decide between a retry and a stated fact.
 */
class PanelError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** One request's abort signal, so an assembly cannot hang the route forever. */
function requestSignal() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timed out')), 5000)
  timer?.unref?.()
  return { signal: controller.signal, done: () => clearTimeout(timer) }
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
 * WHY A PRESET-SCOPE FIBER IS MOUNTED TOO
 *   `restrict()` masks what a scope INHERITS, never what its own layer registers
 *   (`view()` skips the `own` layer when it applies the filters). A preset mounts
 *   its tool rows (`tool-bash`, `tool-fs`, …) into the PRESET's scope, which is an
 *   ANCESTOR of every agent using that preset — so from the agent's own scope those
 *   tools are inherited contributions, and a restriction registered there does mask
 *   them. The restriction is therefore mounted once per agent AND once per preset
 *   scope that has a live agent using it; both read the same table, so a switch
 *   reaches whichever layer holds the tool.
 *
 * The mounted plugin is deliberately tiny and dumb: it holds one applied signature,
 * re-reads the wanted set from this controller when asked, and does nothing else.
 * All of the policy/inheritance logic stays in one place (the table above) instead
 * of being duplicated into N live agent scopes.
 * @param scope - the plugin context (needs `tools`; provides `schemas`).
 * @returns the controller used by the route and by the agent lifecycle listeners.
 */
function createRestrictor(scope, agents) {
  /** scope key -> { holder, fiber, agentId } */
  const entries = new Map()
  let live = true
  let timer
  /** The agent registry, so a pass can resolve one agent's visible names. */
  const agentsRef = agents
  /** Why the last mount attempt failed, for the snapshot's diagnostics. */
  let mountError
  /** The last `restrict()` failure, for the snapshot's diagnostics. */
  let restrictError

  /**
   * Names one agent can actually CALL, or undefined when it cannot say.
   *
   * This — not the global view — is the truth about what the model sees for this
   * session, and it is the set `restrict()` accepts when called from a scope the
   * tool is inherited into. Reading it per agent rather than once per pass is
   * deliberate: two agents can have different visible sets (different presets,
   * different inherited restrictions), so there is no single answer to cache.
   */
  function visibleNamesOf(agent) {
    try {
      return new Set(scope.tools.schemas(agent).map((schema) => schema.name))
    } catch {
      return undefined
    }
  }

  /**
   * The deny list that applies to one agent, cut down to names hiding can mask.
   * @param agentId - the session whose policy applies (after inheritance).
   * @param known - the maskable names for that agent, or undefined when unavailable.
   * @returns the names to mask, or undefined to leave the applied set untouched.
   */
  function wantedFor(agentId, known) {
    if (known === undefined) return undefined
    const deny = denySetFor(agentId)
    if (deny.size === 0) return []
    return [...deny].filter((name) => known.has(name)).sort()
  }

  /**
   * Mount one scope's restriction plugin.
   *
   * The scope is either an AGENT (`agent.ctx`) or a PRESET scope reachable from a
   * live agent — both are legitimate mount points, because a preset's tool rows
   * live in the preset's own layer and are inherited by every agent that uses it.
   * @param key - stable identity for this scope; used to avoid a double mount.
   * @param target - `{ ctx, agent, agentId }`; `agent` is what `schemas()` is read
   * for and `agentId` is the session whose policy applies.
   * @param mount - how to install the fiber into that scope.
   */
  function mountScope(key, target, mount) {
    if (!live) return
    if (typeof key !== 'string' || entries.has(key)) return
    const scopeCtx = target?.ctx
    if (scopeCtx === undefined || typeof scopeCtx.plugin !== 'function') {
      mountError = 'scope has no ctx.plugin (older registry): hiding unavailable'
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
         * Re-apply this scope's restriction.
         * @param agentId - the session whose policy this scope serves.
         * @param known - the maskable names, when the caller already computed them
         * for a whole pass. Omitted on the initial mount, where there is no shared
         * pass, and the scope then reads them for its own agent.
         */
        const sync = (agentId, known) => {
          if (stopped) return
          const names = wantedFor(agentId, known ?? visibleNamesOf(target.agent))
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
            // after the view was read) must not take the whole restriction
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
        sync(target.agentId)
      }
    }

    try {
      // The holder object is stable: the mounted fiber swaps `sync` in place, and the
      // controller reaches it through this map. The agent id travels with the entry
      // so a preset scope serving several agents is re-synced for each of them.
      entries.set(key, { holder, fiber: mount(scopeCtx, plugin), agentId: target.agentId })
      mountError = undefined
    } catch (error) {
      // The scope died between listing and mounting. Leave it to the guard, but say
      // so in the snapshot: a silently un-hidden session is exactly the failure a
      // user cannot diagnose from the UI.
      mountError = String(error?.message ?? error)
    }
  }

  /**
   * Mount one agent's restriction plugin, if that agent exposes a scope.
   *
   * `agent.ctx` is not part of the published Agent interface, so its absence is
   * ordinary (an older registry). The guard still enforces; only hiding is lost.
   */
  function mount(agent) {
    const id = agent?.id
    if (typeof id !== 'string') return
    mountScope(`agent:${id}`, { ctx: agent.ctx, agent, agentId: id }, (ctx, plugin) => ctx.plugin(plugin))
  }

  /**
   * Mount one PRESET scope's restriction plugin.
   *
   * A preset's tool rows (`tool-bash`, `tool-fs`, …) are registered into the
   * preset's own layer, which every agent using that preset inherits. A restriction
   * registered on the agent's own scope DOES mask them, so mounting here is not
   * required for the common case — it is required for the case the agent's own scope
   * cannot reach, and it is the only way to keep the mask alive when a preset scope
   * outlives the agent that first needed it.
   *
   * The key is derived from the scope's identity, never from an agent id: one preset
   * scope may serve many agents, and it must be mounted exactly once.
   */
  function mountPresetScope(scopeCtx, agent, agentId, scopeId) {
    mountScope(
      `preset:${scopeId}`,
      { ctx: scopeCtx, agent, agentId },
      (ctx, plugin) => ctx.plugin(plugin)
    )
  }

  /** Re-read the policy for every mounted scope. */
  function syncAll() {
    if (!live) return
    // One visibility read per agent, not one per scope: the maskable set is a
    // question about what one agent can call, and every scope serving that agent
    // gets the same answer.
    const views = new Map()
    for (const entry of entries.values()) {
      const agentId = entry.agentId
      if (agentId === undefined) continue
      if (!views.has(agentId)) {
        const agent = agentsRef?.get?.(agentId)
        views.set(agentId, agent === undefined ? undefined : visibleNamesOf(agent))
      }
      try {
        entry.holder.sync(agentId, views.get(agentId))
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
   * Mount one agent's restriction on its own scope and every scope above it.
   *
   * The agent's own scope masks what it inherits; the scopes ABOVE it hold the
   * registrations themselves (a preset's tool rows), and those are only maskable
   * from their own layer. Walking the chain is how this works without knowing what
   * a preset is.
   */
  function mountEverywhere(agent) {
    const id = agent?.id
    if (typeof id !== 'string') return
    mount(agent)
    for (const scope of scopesOf(agent).slice(1)) {
      mountPresetScope(scope.ctx, agent, id, scope.id)
    }
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
    entries.delete(`agent:${id}`)
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
    mountEverywhere,
    mountPresetScope,
    syncAll,
    scheduleSync,
    release,
    dispose,
    get size() { return entries.size },
    get error() { return mountError ?? restrictError }
  }
}

// --- skills (protocol 8) ------------------------------------------------------

/** The live agent for one session, or undefined when the session is not running. */
function agentFor(host, sessionId) {
  try {
    return host?.agents?.get?.(sessionId)
  } catch {
    return undefined
  }
}

/** The working directory a skill lookup needs; falls back to the session header. */
async function cwdFor(host, agent, signal) {
  try {
    const cwd = await host?.workingDirectory?.ensure?.(agent, signal)
    if (typeof cwd === 'string' && cwd.length > 0) return cwd
  } catch {
    /* the service is absent or refused; the header below is the fallback */
  }
  const fallback = agent?.session?.header?.cwd
  return typeof fallback === 'string' && fallback.length > 0 ? fallback : undefined
}

/** One skill as the tab draws it. `toggleable` is "there is a file to edit". */
function skillRow(skill) {
  const description = typeof skill?.description === 'string' ? skill.description : ''
  const path = typeof skill?.path === 'string' && skill.path.length > 0 ? skill.path : undefined
  return {
    name: String(skill?.name ?? ''),
    description: description.length > MAX_SKILL_DESCRIPTION
      ? `${description.slice(0, MAX_SKILL_DESCRIPTION - 1)}…`
      : description,
    provider: typeof skill?.provider === 'string' ? skill.provider : undefined,
    source: typeof skill?.source === 'string' ? skill.source : undefined,
    path,
    modelInvocable: skill?.invocation?.modelInvocable !== false,
    userInvocable: skill?.invocation?.userInvocable !== false,
    toggleable: path !== undefined,
    ...(path === undefined ? { reason: 'no-file' } : {})
  }
}

/** List one session's skills. A missing service is a stated fact, not a throw. */
async function skillsState(host, sessionId, signal) {
  const skills = host?.skills
  const base = { protocol: PROTOCOL, sessionId }
  if (skills === undefined || typeof skills.snapshot !== 'function') {
    return { ...base, available: false, reason: 'no-skills-service', skills: [] }
  }
  const agent = agentFor(host, sessionId)
  if (agent === undefined) {
    return { ...base, available: true, reason: 'no-live-agent', skills: [], complete: false }
  }
  const cwd = await cwdFor(host, agent, signal)
  const snapshot = await skills.snapshot({
    ...(cwd === undefined ? {} : { cwd }),
    signal,
    scope: agent
  })
  const rows = Array.isArray(snapshot?.skills)
    ? snapshot.skills.map(skillRow).filter((row) => row.name.length > 0)
    : []
  rows.sort((left, right) => left.name.localeCompare(right.name))
  return { ...base, available: true, complete: snapshot?.complete !== false, skills: rows }
}

let skillRefreshSeq = 0

/**
 * Force the skill registry to re-collect after this plugin rewrote a skill file.
 *
 * A first-party `write`/`edit` tool emits `fs/observed`, which is what normally
 * invalidates the filesystem provider; this panel is not a tool, so it has no such
 * event to emit and the file watcher's own settling delay would make the switch
 * look stuck. Registering and disposing an empty provider is a public, honest
 * mutation of the registry's layers — it clears the collect cache, and the
 * filesystem provider re-discovers its roots on the next `snapshot()`.
 */
async function refreshSkillCatalog(host) {
  const skills = host?.skills
  if (skills !== undefined && typeof skills.registerProvider === 'function') {
    skillRefreshSeq += 1
    let off
    try {
      off = skills.registerProvider(() => ({
        name: `tools-panel-refresh-${process.pid}-${skillRefreshSeq}`,
        list: async () => ({ candidates: [], complete: true }),
        get: async () => undefined
      }))
    } catch {
      off = undefined
    }
    if (off !== undefined) {
      try {
        off()
      } catch {
        /* the layer is already gone */
      }
      await Promise.resolve()
      return
    }
  }
  // No registry control: give the filesystem watcher one settling window instead of
  // reporting an answer we have not actually observed.
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 250)
    timer?.unref?.()
  })
}

/**
 * Flip one skill's model visibility by editing its frontmatter.
 *
 * The path comes from the registry's own summary, never from the request body: the
 * route can only touch a file the skill provider already discovered.
 */
async function toggleSkill(host, sessionId, name, enabled, signal) {
  const listed = await skillsState(host, sessionId, signal)
  if (listed.available !== true) {
    throw new PanelError(409, 'the skills service is unavailable in this deployment')
  }
  const row = listed.skills.find((skill) => skill.name === name)
  if (row === undefined) throw new PanelError(404, `unknown skill "${name}"`)
  if (row.toggleable !== true || typeof row.path !== 'string') {
    throw new PanelError(409, 'this skill is provided at runtime and has no file to edit')
  }
  const path = row.path
  let before
  let first
  try {
    before = readFileSync(path, 'utf8')
    first = statSync(path)
  } catch (error) {
    throw new PanelError(409, `could not read ${path}: ${error?.message ?? error}`)
  }
  const next = patchSkillFrontmatter(before, enabled)
  if (next === undefined) {
    throw new PanelError(409, 'the skill file has no closed frontmatter block to edit')
  }
  const again = statSync(path)
  if (again.mtimeMs !== first.mtimeMs || again.size !== first.size) {
    throw new PanelError(409, 'the skill file changed while it was being edited; retry')
  }
  try {
    writeFileAtomic(path, next)
  } catch (error) {
    throw new PanelError(500, `could not write ${path}: ${error?.message ?? error}`)
  }
  await refreshSkillCatalog(host)
  let after
  try {
    after = await skillsState(host, sessionId, signal)
  } catch {
    after = undefined
  }
  const applied = after?.skills?.find((skill) => skill.name === name)?.modelInvocable === enabled
  return { state: after ?? listed, applied }
}

// --- prompt sections (protocol 8) --------------------------------------------

/**
 * One assembled section, in the shape the tab draws.
 *
 * `liveChars` is the text length in the CURRENT assembly, while `chars` is what the
 * preview shows (a disabled section still previews its last known text). Keeping
 * both is what lets the route verify that a shadow really took effect without
 * mistaking the cached preview for the live prompt.
 */
function promptRows(raw) {
  const live = raw
    .map((section) => {
      const name = String(section?.name ?? '')
      const text = typeof section?.text === 'string' ? section.text : String(section?.text ?? '')
      return { name, text }
    })
    .filter((section) => section.name.length > 0)
  const sole = live.length === 1
  const rows = live.map((section) => {
    const enabled = !promptDisabled.has(section.name)
    if (enabled && section.text.length > 0) noteSectionText(section.name, section.text)
    const shown = enabled ? section.text : (lastSectionText.get(section.name) ?? section.text)
    const cut = truncateText(shown, MAX_SECTION_TEXT)
    return {
      name: section.name,
      text: cut.text,
      chars: shown.length,
      truncated: cut.truncated,
      enabled,
      present: true,
      liveChars: section.text.length,
      // The only section is the whole prompt: switching it off would leave nothing
      // to send. It can still be switched back ON when it is already off.
      toggleable: !sole || !enabled,
      ...(sole && enabled ? { reason: 'sole-section' } : {})
    }
  })
  for (const name of promptDisabled) {
    if (live.some((section) => section.name === name)) continue
    const shown = lastSectionText.get(name) ?? ''
    const cut = truncateText(shown, MAX_SECTION_TEXT)
    rows.push({
      name,
      text: cut.text,
      chars: shown.length,
      truncated: cut.truncated,
      enabled: false,
      present: false,
      liveChars: 0,
      toggleable: true
    })
  }
  return rows
}

/** Assemble one agent's prompt sections, through the same context shape the loop uses. */
async function assembleSections(host, agent, signal) {
  const systemPrompt = host?.systemPrompt
  if (systemPrompt === undefined || typeof systemPrompt.assemble !== 'function') {
    throw new PanelError(409, 'the systemPrompt service is unavailable in this deployment')
  }
  const assembly = await systemPrompt.assemble({ agent, scope: agent, ...(signal === undefined ? {} : { signal }) })
  return Array.isArray(assembly?.sections) ? assembly.sections : []
}

/** The prompt tab's state for one session. */
async function promptsState(host, sessionId, signal) {
  const base = {
    protocol: PROTOCOL,
    sessionId,
    disabled: [...promptDisabled].sort(),
    sections: []
  }
  if (host?.systemPrompt === undefined) {
    return { ...base, available: false, reason: 'no-system-prompt' }
  }
  const agent = agentFor(host, sessionId)
  if (agent === undefined) {
    return {
      ...base,
      available: true,
      reason: 'no-live-agent',
      sections: promptRows([])
    }
  }
  let raw
  try {
    raw = await assembleSections(host, agent, signal)
  } catch (error) {
    if (error instanceof PanelError) {
      return { ...base, available: false, reason: 'no-system-prompt' }
    }
    return {
      ...base,
      available: false,
      reason: 'assemble-failed',
      error: String(error?.message ?? error)
    }
  }
  return { ...base, available: true, sections: promptRows(raw) }
}

/** Write one name into the disabled set and re-sync every live agent's shadow. */
function setPromptDisabled(host, name, enabled) {
  if (enabled) promptDisabled.delete(name)
  else promptDisabled.add(name)
  savePrompts(promptDisabled)
  host?.prompts?.syncAll?.()
}

/**
 * Flip one prompt section off/on, then PROVE the switch took effect.
 *
 * An empty same-name section only shadows a section registered in an ancestor
 * layer; a section the agent itself registered cannot be shadowed, and a section
 * that was the whole prompt would leave nothing behind. Both are detected from a
 * fresh assembly and rolled back, because a switch that springs back is exactly
 * the failure this panel exists to make visible.
 */
async function togglePromptSection(host, sessionId, name, enabled, signal) {
  if (host?.systemPrompt === undefined) {
    throw new PanelError(409, 'the systemPrompt service is unavailable in this deployment')
  }
  const agent = agentFor(host, sessionId)
  const beforeRaw = agent === undefined ? [] : await assembleSections(host, agent, signal)
  const before = promptRows(beforeRaw)
  const beforePresent = before.filter((row) => row.present).length
  // Disabling a name that is not in the assembly would persist a dead switch, and a
  // later plugin registering that name would then be off without the user seeing why.
  if (!enabled && !before.some((row) => row.name === name)) {
    throw new PanelError(404, `unknown prompt section "${name}"`)
  }
  if (!enabled && beforePresent === 1) {
    throw new PanelError(409, 'this is the only prompt section; switching it off would leave the prompt empty')
  }
  setPromptDisabled(host, name, enabled)
  try {
    if (agent === undefined) {
      return { state: await promptsState(host, sessionId, signal), applied: false, reason: 'no-live-agent' }
    }
    const afterRaw = await assembleSections(host, agent, signal)
    const after = promptRows(afterRaw)
    const afterRow = after.find((row) => row.name === name && row.present)
    const liveBefore = before.filter((row) => row.present).reduce((sum, row) => sum + row.liveChars, 0)
    const liveAfter = after.filter((row) => row.present).reduce((sum, row) => sum + row.liveChars, 0)
    let failure
    if (!enabled && afterRow !== undefined && afterRow.liveChars > 0) {
      failure = 'this section is registered inside the agent itself and cannot be shadowed from this panel'
    }
    if (!enabled && liveBefore > 0 && liveAfter === 0) {
      failure = 'switching this section off would leave the prompt empty'
    }
    if (failure !== undefined) {
      setPromptDisabled(host, name, !enabled)
      throw new PanelError(409, failure)
    }
    return { state: await promptsState(host, sessionId, signal), applied: true }
  } catch (error) {
    // Any failure after the write must not leave the persisted set disagreeing with
    // what is actually applied.
    if (promptDisabled.has(name) !== !enabled) setPromptDisabled(host, name, !enabled)
    throw error
  }
}

/** Put every disabled section back: clear the set and drop every shadow. */
async function resetPromptSections(host, sessionId, signal) {
  promptDisabled.clear()
  savePrompts(promptDisabled)
  host?.prompts?.syncAll?.()
  return promptsState(host, sessionId, signal)
}

/**
 * Mount one empty-shadow plugin into each live agent's scope.
 *
 * `systemPrompt.section()` registers into the CALLING context's layer, so a fiber
 * mounted on `agent.ctx` writes into that agent's own layer — which is nearer than
 * the global and preset layers where the injected sections live. The nearest
 * layer wins a duplicate name, and an empty section is dropped by `renderPrompt`,
 * so the net effect is "this section is not injected for this agent".
 */
function createPromptShadows(scope, agents) {
  const entries = new Map()
  let live = true
  let mountError

  function mount(agent) {
    if (!live) return
    const id = agent?.id
    if (typeof id !== 'string' || entries.has(id)) return
    const agentCtx = agent?.ctx
    if (agentCtx === undefined || typeof agentCtx.plugin !== 'function') {
      mountError = 'agent scope has no ctx.plugin (older registry): prompt shadows unavailable'
      return
    }
    const holder = { sync: () => {} }
    const plugin = {
      name: 'dsh-plugin-tools-panel:prompt-shadow',
      inject: ['systemPrompt'],
      apply(c) {
        let stopped = false
        let applied
        let disposers = []
        const clear = () => {
          for (const off of disposers.splice(0)) {
            try {
              off()
            } catch {
              /* the layer is already gone */
            }
          }
        }
        const sync = (names) => {
          if (stopped) return
          const signature = names.join('\u0000')
          if (signature === applied) return
          applied = signature
          clear()
          for (const name of names) {
            try {
              disposers.push(c.systemPrompt.section({ name, order: 0, text: '' }))
            } catch {
              // A name this agent registered itself cannot be shadowed from its own
              // layer. The route's verification reports it; the other names still apply.
            }
          }
        }
        holder.sync = sync
        try {
          c.effect(() => () => {
            stopped = true
            holder.sync = () => {}
            clear()
          })
        } catch {
          /* a minimal context without effect: the fiber teardown still runs */
        }
        sync([...promptDisabled])
      }
    }
    try {
      entries.set(id, { holder, fiber: agentCtx.plugin(plugin) })
      mountError = undefined
    } catch (error) {
      mountError = String(error?.message ?? error)
    }
  }

  function syncAll() {
    if (!live) return
    let list = []
    try {
      list = agents?.list?.() ?? []
    } catch {
      return
    }
    for (const agent of list) {
      mount(agent)
      try {
        entries.get(agent.id)?.holder.sync?.([...promptDisabled])
      } catch {
        /* one dead scope must not stop the rest */
      }
    }
  }

  function release(id) {
    entries.delete(id)
  }

  function dispose() {
    live = false
    for (const entry of entries.values()) {
      try {
        entry.fiber?.dispose?.()
      } catch {
        /* already gone */
      }
    }
    entries.clear()
  }

  return {
    mount,
    syncAll,
    release,
    dispose,
    get size() { return entries.size },
    get error() { return mountError }
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

/** A skill or section name as it may appear in a JSON body. */
function cleanPanelName(value) {
  if (typeof value !== 'string') return undefined
  const name = value.trim()
  if (name.length === 0 || name.length > MAX_NAME) return undefined
  if (/[\u0000-\u001f\u007f]/.test(name)) return undefined
  return name
}

/**
 * Serve the skills route.
 *
 * GET lists the session's skills; POST flips one skill's model visibility by
 * editing that skill file's frontmatter. The file path always comes from the
 * registry summary, never from the request.
 */
async function handleSkills(req, res, host) {
  const url = new URL(req.url ?? SKILLS_ROUTE, 'http://localhost')
  if (req.method === 'GET') {
    const sessionId = cleanSessionId(url.searchParams.get('sessionId'))
    if (sessionId === undefined) {
      sendJson(res, 400, { ok: false, error: 'missing sessionId query parameter' })
      return
    }
    const { signal, done } = requestSignal()
    try {
      sendJson(res, 200, { ok: true, state: await skillsState(host, sessionId, signal) })
    } catch (error) {
      sendJson(res, error instanceof PanelError ? error.status : 500, {
        ok: false,
        error: String(error?.message ?? error)
      })
    } finally {
      done()
    }
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
  let payload
  try {
    const body = await readBody(req)
    payload = body ? JSON.parse(body) : {}
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
  const name = cleanPanelName(payload.name)
  if (name === undefined) {
    sendJson(res, 400, { ok: false, error: '`name` must be a non-empty skill name' })
    return
  }
  if (typeof payload.enabled !== 'boolean') {
    sendJson(res, 400, { ok: false, error: '`enabled` must be a boolean' })
    return
  }
  const { signal, done } = requestSignal()
  try {
    const answer = await toggleSkill(host, sessionId, name, payload.enabled, signal)
    sendJson(res, 200, { ok: true, state: answer.state, applied: answer.applied })
  } catch (error) {
    sendJson(res, error instanceof PanelError ? error.status : 500, {
      ok: false,
      error: String(error?.message ?? error)
    })
  } finally {
    done()
  }
}

/**
 * Serve the prompt-sections route.
 *
 * GET lists the sections actually assembled for one session; POST switches one
 * section off/on (globally, persisted) or resets the whole disabled set. Nothing
 * here edits a prompt: the switch is an empty same-name shadow in the agent scope.
 */
async function handlePrompts(req, res, host) {
  const url = new URL(req.url ?? PROMPTS_ROUTE, 'http://localhost')
  if (req.method === 'GET') {
    const sessionId = cleanSessionId(url.searchParams.get('sessionId'))
    if (sessionId === undefined) {
      sendJson(res, 400, { ok: false, error: 'missing sessionId query parameter' })
      return
    }
    const { signal, done } = requestSignal()
    try {
      sendJson(res, 200, { ok: true, state: await promptsState(host, sessionId, signal) })
    } catch (error) {
      sendJson(res, error instanceof PanelError ? error.status : 500, {
        ok: false,
        error: String(error?.message ?? error)
      })
    } finally {
      done()
    }
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
  let payload
  try {
    const body = await readBody(req)
    payload = body ? JSON.parse(body) : {}
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
  const { signal, done } = requestSignal()
  try {
    if (payload.reset === true) {
      sendJson(res, 200, { ok: true, state: await resetPromptSections(host, sessionId, signal) })
      return
    }
    const name = cleanPanelName(payload.name)
    if (name === undefined) {
      sendJson(res, 400, { ok: false, error: '`name` must be a non-empty section name' })
      return
    }
    if (typeof payload.enabled !== 'boolean') {
      sendJson(res, 400, { ok: false, error: '`enabled` must be a boolean' })
      return
    }
    const answer = await togglePromptSection(host, sessionId, name, payload.enabled, signal)
    sendJson(res, 200, { ok: true, state: answer.state, applied: answer.applied })
  } catch (error) {
    sendJson(res, error instanceof PanelError ? error.status : 500, {
      ok: false,
      error: String(error?.message ?? error)
    })
  } finally {
    done()
  }
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
  scope.effect(
    () => host.register({ kind: 'exact', path: SKILLS_ROUTE, handler: (req, res) => handleSkills(req, res, deps) }),
    'tools-panel: skills route'
  )
  scope.effect(
    () => host.register({ kind: 'exact', path: PROMPTS_ROUTE, handler: (req, res) => handlePrompts(req, res, deps) }),
    'tools-panel: prompts route'
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
 * The scopes a tool registration can live in, above and including one agent.
 *
 * A tool is visible to an agent when it sits in the global layer or in ANY layer on
 * the agent's scope chain, and `restrict()` masks exactly those inherited
 * contributions. So the set of scopes worth mounting is the agent's own scope plus
 * every scope above it — which is where a PRESET's tool rows live
 * (`tool-bash`, `tool-fs`, … are registered by the preset's plugin tree, not by the
 * host composition).
 *
 * The chain is walked through Cordis's own links, so nothing here needs to know what
 * a preset is or how it is mounted: whatever scope handed the agent its tools is
 * found by the same walk. Two spellings are tried because the published shape only
 * guarantees one of them: `ctx.fiber.parent` is the documented parent CONTEXT, while
 * a context's `parent` is a plain field on some fiber shapes. Absence of both is
 * ordinary — the guard still enforces, and only hiding degrades.
 * @param agent - the live agent.
 * @returns `{ ctx, id }[]`, nearest first; empty when the chain is not walkable.
 */
function scopesOf(agent) {
  const scopes = []
  const seen = new Set()
  for (let ctx = agent?.ctx; ctx !== undefined && ctx !== null; ctx = nextScopeOf(ctx)) {
    if (seen.has(ctx)) break
    seen.add(ctx)
    if (typeof ctx.plugin !== 'function') continue
    // A stable identity for the scope. `fiber.uid` is the natural key when
    // present; the fiber itself, then the context, are the fallbacks. The set above
    // keeps the walk finite even if a link points back at a visited scope.
    const id = ctx.fiber?.uid ?? ctx.fiber ?? ctx
    scopes.push({ ctx, id: String(id) })
  }
  return scopes
}

/** The enclosing context of one scope, by whichever link this Cordis exposes. */
function nextScopeOf(ctx) {
  const parent = ctx?.fiber?.parent ?? ctx?.parent
  // `fiber.parent` is a CONTEXT on the documented shape; guard against a bare fiber
  // being handed back by an older one, since only a context can mount a plugin.
  return parent !== undefined && typeof parent.plugin === 'function' ? parent : undefined
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
  // takes the plugin's own context so it can read each agent's schema view.
  const restrictor = createRestrictor(ctx, ctx.get('agents'))
  ctx.effect(() => () => restrictor.dispose(), 'tools-panel: restriction scopes')

  // The prompt tab's other half: one empty same-name section per disabled section,
  // mounted inside each live agent's scope. Created even without `agents` so the
  // route can persist a switch; with no registry it simply has no scopes to mount.
  const promptShadows = createPromptShadows(ctx, ctx.get('agents'))
  ctx.effect(() => () => promptShadows.dispose(), 'tools-panel: prompt shadows')

  ctx.effect(() => ctx.tools.guard(makeGuard(policies, parents)), 'tools-panel: live guard')

  // Mount on the agent's own scope AND on the scopes above it: a preset's tool rows
  // are inherited from there, and only a restriction registered on the scope that
  // HOLDS the tool can mask it.
  const mountWithAncestors = (agent) => restrictor.mountEverywhere(agent)

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
        mountWithAncestors(agent)
        promptShadows.mount(agent)
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
        promptShadows.release(agent.id)
      }),
      'tools-panel: tree cleanup'
    )
    for (const agent of agents.list()) {
      mountWithAncestors(agent)
      promptShadows.mount(agent)
    }
    // A section switched off before this process had any agent must apply now.
    promptShadows.syncAll()
  }

  // A tool that appears after the switch was set (an MCP server connecting) must be
  // hidden for sessions that already deny it. Deferred, so `restrict()`'s own
  // synchronous `tools/change` cannot recurse through this listener.
  ctx.effect(() => ctx.on('tools/change', () => restrictor.scheduleSync()), 'tools-panel: tool set changes')

  const deps = {
    tools: ctx.tools,
    agents,
    restrictor,
    prompts: promptShadows,
    // Probed per request, not captured at apply time: a service that appears after
    // this plugin mounts must still answer the tab instead of being reported absent.
    get skills() { return ctx.get('skills') },
    get workingDirectory() { return ctx.get('workingDirectory') },
    get systemPrompt() { return ctx.get('systemPrompt') }
  }
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
  MAX_PROMPTS,
  MAX_SECTION_TEXT,
  MAX_SKILL_DESCRIPTION,
  MAX_TOOLS,
  PROMPTS_ROUTE,
  PROTOCOL,
  ROUTE,
  SKILLS_ROUTE,
  cleanDeny,
  createPromptShadows,
  createRestrictor,
  denyReason,
  denySetFor,
  groupsFile,
  loadGroups,
  loadPrompts,
  makeGuard,
  normalizeGroups,
  normalizePromptNames,
  ownerOf,
  parents,
  patchSkillFrontmatter,
  policies,
  policyFor,
  promptsFile,
  promptsState,
  saveGroups,
  savePrompts,
  scopesOf,
  setDeny,
  skillsState,
  snapshot,
  togglePromptSection,
  toggleSkill,
  resetPromptSections,
  toolsForSession
}

/** Test-only: the live disabled-section names. */
export function getPromptDisabled() {
  return [...promptDisabled].sort()
}

/** Test-only: replace the live disabled set without touching disk. */
export function replacePromptDisabled(names) {
  promptDisabled = new Set(normalizePromptNames(names))
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
