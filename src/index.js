/**
 * Tool guard, host half: a live, GLOBAL, PER-TOOL kill-switch.
 *
 * WHAT THE SWITCH IS
 *   The profile carries a DENY SET of tool names. Nothing else: there are no kinds,
 *   no groups, and no built-in table of which tool belongs to which group. The set
 *   is edited by the composer control and read by this half on every call, so the
 *   next tool call already sees it — no reload, no restart, not even a re-render.
 *
 * TWO MECHANISMS, ON PURPOSE
 *   1. HIDING (`system-prompt/assemble`). The denied tools are removed from the
 *      schema list handed to the model, so they are never offered in the first
 *      place. This is the primary mechanism: the model does not see the tool, so it
 *      does not call it, and the request is smaller.
 *
 *      WHY NOT `ctx.tools.restrict()`, WHICH IS THE DOCUMENTED WAY TO HIDE A TOOL
 *      `restrict()` filters what a scope INHERITS and never what its own layer
 *      registers — an exemption the delegation runtime depends on, because that is
 *      how a child gets its own structured-output tools. Every agent-local tool
 *      (the `subagent` / `team_task_*` / `wait_agent` family) therefore made
 *      `restrict()` throw "unknown global tool", so the switch showed off while the
 *      model was still offered the tool. Filtering the assembled schema list is
 *      layer-agnostic and removes both kinds.
 *
 *      The listener is registered ONCE, on the plugin's own context. The waterfall
 *      dispatch resolves listeners through `scopeTarget`, whose filter accepts a
 *      scope-less registration for every scope, so one listener covers all live
 *      agents and every agent created later — no per-agent mount, no re-sync, no
 *      release on disposal, and no scope chain to walk.
 *
 *   2. GUARDING (`ctx.tools.guard()`). A backstop, and deliberately kept. The filter
 *      only shapes what the MODEL is shown; it cannot stop a call that arrives from
 *      conversation history, from a resumed session whose header predates the
 *      switch, or through a PTC sub-dispatch. The guard is a SYNCHRONOUS monotonic
 *      check in the execution pipeline, so such a call is refused with a reason the
 *      model can read even when the schema no longer lists it.
 *
 * WHY THE GUARD IS NOT THE PRIMARY MECHANISM
 *   A guard can only refuse a call that was already made. That burns a step per
 *   refusal — the model sees a tool, calls it, is told no, and tries something else.
 *   Removing it from the schema list prevents the attempt instead of describing its
 *   refusal.
 *
 * SCOPE: THE WHOLE PROFILE
 *   The deny set has NO session dimension. A name denied here is denied for every
 *   agent in this profile, including subagents and sessions created later. That is
 *   what makes this tab behave like the skills and prompts tabs: one durable answer
 *   about the environment, not a restriction on one conversation.
 *
 *   Nothing has to be re-applied when the set changes: the filter reads the live
 *   deny set during each assembly, so the next model step already reflects the edit.
 *
 *   A call with NO agent is governed too: the set is global, so there is no session
 *   to consult and nothing to exempt.
 *
 * WHAT POPULATES THE LIST
 *   The control lists the tools the session can actually see, read from the
 *   registry (`ctx.tools.schemas(agent)`) at the moment the menu opens. Nothing is
 *   hard-coded here: an MCP server or a third-party plugin that registers a tool
 *   shows up in the menu by itself, and uninstalls disappear from it. The names
 *   that are currently denied are always listed too: the registry still holds them,
 *   and without them a denied tool could never be re-enabled.
 *
 * PERSISTENCE
 *   The deny set is DURABLE and global: one file under `DSH_HOME`, written on every
 *   change and read back at load. A switch survives a restart, exactly like a
 *   disabled skill or a disabled prompt section. This was deliberately changed from
 *   an in-memory per-session panic switch: three tabs with one switch control must
 *   not mean three different lifetimes.
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
 *   they are the user's organization of their own tool list. The deny list is now
 *   durable and global for the same reason.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
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
 * shadowed by an empty same-name section in every live agent's scope. 9 made the
 * TOOL deny set global and durable: the snapshot lost `ownerId`/`inherited` and
 * gained a persisted `tools.json`, so a client must not assume a per-session list.
 */
const PROTOCOL = 9

/**
 * Where the user's own group definitions live.
 *
 * Groups are NOT policy: they are the user's organization of their tool list, so
 * they are global and durable, exactly like the deny set now is. A group is a name
 * plus member names; a tool may sit in several groups, and a group's switch is only
 * a bulk action over its members' deny state.
 *
 * `DSH_HOME` is set in every profile-launched process; the homedir fallback keeps a
 * bare `dsh` invocation from writing to `/`.
 */
function panelDir() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'dsh-plugin-tools-panel')
}

/** Where the denied tool names live. Global and durable, like skills and prompts. */
function toolsFile() {
  return join(panelDir(), 'tools.json')
}

function groupsFile() {
  return join(panelDir(), 'groups.json')
}

/**
 * Read the saved denied tool names.
 *
 * A missing file is "nothing denied yet", and a corrupt one is treated the same way
 * rather than throwing: losing the switch must never take the plugin — and
 * therefore the kill switch — down with it.
 * @returns a deduplicated array of tool names.
 */
function loadTools() {
  try {
    const parsed = JSON.parse(readFileSync(toolsFile(), 'utf8'))
    return normalizePromptNames(parsed?.disabled)
  } catch {
    return []
  }
}

/** Persist the denied tool names atomically enough that a crash cannot truncate. */
function saveTools() {
  try {
    const file = toolsFile()
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.tmp-${process.pid}`
    writeFileSync(temp, `${JSON.stringify({ version: 1, disabled: [...denied] }, null, 2)}\n`, 'utf8')
    renameSync(temp, file)
  } catch {
    // A read-only home keeps the switch in memory for this process: degraded, but
    // the panel keeps working, which is the part that matters.
  }
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

// --- disabled runtime skills ---------------------------------------------------

/**
 * Where "this skill is off, but it has no file to edit" lives.
 *
 * A file-backed skill is switched by editing its frontmatter. A RUNTIME skill (a
 * plugin's own registration, the built-in Office skill) has no SKILL.md, so the
 * switch is a same-name runtime registration in each agent's own layer with BOTH
 * invocation flags false: the model catalog filters `modelInvocable`, `/name`
 * filters `userInvocable`, and the nearest-layer duplicate rule makes that empty
 * shadow win over the real one. The set is global (every live agent gets it) and
 * durable (this file), so the switch survives a restart.
 */
function skillsFile() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'dsh-plugin-tools-panel', 'skills.json')
}

/** Read the saved disabled-skill names; a missing or corrupt file means none. */
function loadSkillDisabled() {
  try {
    const parsed = JSON.parse(readFileSync(skillsFile(), 'utf8'))
    return normalizePromptNames(parsed?.disabled)
  } catch {
    return []
  }
}

/** Persist the disabled-skill names atomically enough that a crash cannot truncate. */
function saveSkillDisabled() {
  try {
    const file = skillsFile()
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.tmp-${process.pid}`
    writeFileSync(temp, `${JSON.stringify({ version: 1, disabled: [...skillDisabled] }, null, 2)}\n`, 'utf8')
    renameSync(temp, file)
  } catch {
    // A read-only home keeps the switch in memory for this process, which is the
    // degraded-but-working outcome the prompt switches also accept.
  }
}

/** The live disabled-skill set, loaded once at module load and written on every change. */
let skillDisabled = new Set(loadSkillDisabled())

/**
 * A runtime skill can only be switched off by a shadow, and a shadow can only be
 * registered into a live agent's scope. This is that half: one plugin fiber per
 * agent that keeps a same-name registration alive for every disabled name.
 */
function createSkillShadows(scope, agents) {
  const entries = new Map()
  let live = true
  let mountError

  function mount(agent) {
    if (!live) return
    const id = agent?.id
    if (typeof id !== 'string' || entries.has(id)) return
    const agentCtx = agent?.ctx
    if (agentCtx === undefined || typeof agentCtx.plugin !== 'function') {
      mountError = 'agent scope has no ctx.plugin (older registry): skill shadows unavailable'
      return
    }
    const holder = { sync: () => {} }
    const plugin = {
      name: 'dsh-plugin-tools-panel:skill-shadow',
      inject: ['skills'],
      apply(c) {
        let stopped = false
        const disposers = new Map()
        const clear = () => {
          for (const off of disposers.values()) {
            try {
              off()
            } catch {
              /* the layer is already gone */
            }
          }
          disposers.clear()
        }
        const sync = (names) => {
          if (stopped) return
          const wanted = new Set(names)
          for (const [name, off] of [...disposers]) {
            if (wanted.has(name)) continue
            try {
              off()
            } catch {
              /* the layer is already gone */
            }
            disposers.delete(name)
          }
          for (const name of wanted) {
            if (disposers.has(name)) continue
            try {
              disposers.set(name, c.skills.register(shadowSkill(name)))
            } catch (error) {
              // One name the layer refuses must not cost the others their shadow;
              // the route's verification reports it.
              mountError = String(error?.message ?? error)
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
        sync([...skillDisabled])
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
        entries.get(agent.id)?.holder.sync?.([...skillDisabled])
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

/** The empty same-name definition that hides a runtime skill on every boundary. */
function shadowSkill(name) {
  return {
    name,
    description: skillDescriptions.get(name) ?? 'Disabled in the tools panel.',
    content: '',
    source: 'dsh-plugin-tools-panel',
    invocation: { modelInvocable: false, userInvocable: false }
  }
}

/** The last observed description per skill, so a shadowed row still reads like itself. */
const skillDescriptions = new Map()

/** Remember a real skill's description; a shadow must not overwrite it with its own. */
function noteSkillDescription(row) {
  if (row.source === 'dsh-plugin-tools-panel') return
  if (!skillDescriptions.has(row.name) && skillDescriptions.size >= MAX_SECTION_CACHE) return
  skillDescriptions.set(row.name, row.description)
}

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
 * Turn OFF a `disable-model-invocation` key that a skill's file already carries.
 *
 * The switch itself never edits files (it is a scoped shadow). The one exception is
 * turning a skill ON whose SKILL.md was already marked disabled — by an earlier
 * version of this panel, or by the skill author. Without clearing that line the
 * switch could never take effect, so "on" would be a lie. Exactly one top-level key
 * is touched; the rest of the file is preserved byte for byte.
 */
function clearFrontmatterDisable(path) {
  try {
    const text = readFileSync(path, 'utf8')
    const key = /^disable-model-invocation[ \t]*:[ \t]*true[ \t]*$/m
    if (!key.test(text)) return
    writeFileAtomic(path, text.replace(key, 'disable-model-invocation: false'))
  } catch {
    /* verification below reports what the catalog actually sees */
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
 * The live switch, GLOBAL and by name.
 *
 * A name appears here only once it is denied; absence means that tool is allowed
 * everywhere. There is no session dimension at all: a name denied in this panel is
 * denied for every agent in this profile, which is what makes the tools tab behave
 * like the skills and prompts tabs (one durable answer about the environment, not a
 * per-conversation restriction).
 *
 * `blocked` and `last` are diagnostics: they distinguish a restriction that is
 * working from one that was configured but never fired. The control does not print
 * them, but they stay on the snapshot because reading one JSON response is the
 * fastest way to answer "is this guard actually running" — and because a NAME that
 * had to fall back to the guard (a scope-local tool that `restrict()` cannot mask)
 * shows up there rather than disappearing silently.
 */
let denied = new Set(loadTools())
let blocked = 0
let lastDenial

/**
 * The user's group definitions, loaded once at module load and written back on every
 * change. Global, not per session: see the header's GROUPS section.
 */
let groups = loadGroups()

/** No names denied. Shared, because it must never be mutated. */
const EMPTY_DENY = new Set()

/** The exact set of denied names (never mutated by a caller). */
function denySetFor() {
  return denied
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
 * Build the synchronous guard.
 *
 * Reads the live module-level set rather than a captured one: `setDeny` REPLACES
 * the set on every edit, so a closure over the old value would enforce a list that
 * no longer exists.
 * @returns the guard, in the `ctx.tools.guard()` shape.
 */
function makeGuard() {
  return function guard(exec) {
    if (!denied.has(exec.name)) return undefined
    blocked += 1
    lastDenial = { tool: exec.name, at: new Date().toISOString(), sessionId: exec.agent?.id }
    return denyReason(exec.name)
  }
}

// --- per-agent hiding ---------------------------------------------------------

/**
 * The prompt-level filter: remove denied tools from the schema list the model is shown.
 *
 * WHY THIS REPLACES `tools.restrict()`
 *   `restrict()` can only mask what a scope INHERITS. It never touches the scope's
 *   OWN layer — and the delegation runtime registers its tools (`subagent`,
 *   `send_team`, the `team_task_*` family, `wait_agent`, `interrupt_agent`,
 *   `list_agents`, `list_subagent_models`) into the agent's own layer precisely so a
 *   per-child capability filter cannot strip them. For those names `restrict()`
 *   throws "unknown global tool", so the tool stayed in the model's schema list while
 *   the panel showed its switch as off. That is the "still visible after disabling"
 *   symptom this module now fixes.
 *
 * THE HOOK
 *   `system-prompt/assemble` is the waterfall that produces the prompt AND the tool
 *   schemas for one step; the loop then feeds `assembly.tools` straight into the
 *   request. Its return value replaces the whole assembly, which is exactly what
 *   makes a filter possible here: nothing else in the pipeline can remove a tool that
 *   a plugin registered into its own scope.
 *
 *   The hook is registered on the PLUGIN's context, not per agent. `waterfall` is
 *   dispatched through `scopeTarget(this, scope)`, and that filter accepts a listener
 *   registered with no scope for every scope (`tag === void 0` returns true). One
 *   registration therefore covers every agent, including ones created later, and
 *   there are no per-agent fibers to mount, re-sync, or clean up.
 *
 * THE COST, STATED PLAINLY
 *   The Harness plugin guide says not to add or remove tools through this waterfall,
 *   because the return value replaces the entire assembly and a careless listener
 *   silently drops other plugins' contributions. This listener is written to be the
 *   narrowest possible violation: it awaits `next()`, keeps every field it was
 *   handed, and replaces only `tools` with a filtered copy. It never invents a tool,
 *   never reorders, and never touches `sections`, `contexts`, or `variables`.
 * @returns a disposer; the listener is removed with it.
 */
function createSchemaFilter() {
  return (assembly, _context, next) =>
    Promise.resolve(next()).then((resolved) => {
      // No deny set: hand the assembly back untouched, so the common case costs one
      // identity return and cannot perturb another plugin's work.
      if (denied.size === 0) return resolved
      const tools = resolved?.tools
      if (!Array.isArray(tools)) return resolved
      const kept = tools.filter((schema) => !denied.has(schema?.name))
      // Same length means nothing was denied for this scope; return the ORIGINAL
      // value so an unchanged request keeps its identity for downstream caching.
      if (kept.length === tools.length) return resolved
      return { ...resolved, tools: kept }
    })
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

/**
 * One skill as the tab draws it.
 *
 * Every row is switchable: the switch is a scoped runtime shadow, which works the
 * same whether or not the skill also has a file. `path` stays for display only.
 */
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
    toggleable: true
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
  for (const row of rows) noteSkillDescription(row)
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
 * Flip one skill off or on.
 *
 * ONE mechanism for every skill: a same-name runtime registration in each agent's
 * layer with BOTH invocation flags false. The nearest layer wins a duplicate, so the
 * empty shadow hides the real skill from the model catalog (`modelInvocable`) and
 * from `/name` (`userInvocable`) — neither path can reach it — without editing a
 * file or any plugin. That is what makes plugin-injected and bundled skills
 * switchable at all, and it keeps file-backed skills on the same footing instead of
 * rewriting their frontmatter.
 *
 * The disabled set is persisted and rolled back if the re-read disagrees.
 */
async function toggleSkill(host, sessionId, name, enabled, signal) {
  const listed = await skillsState(host, sessionId, signal)
  if (listed.available !== true) {
    throw new PanelError(409, 'the skills service is unavailable in this deployment')
  }
  const row = listed.skills.find((skill) => skill.name === name)
  if (row === undefined) throw new PanelError(404, `unknown skill "${name}"`)

  // A shadow can only ADD a disable; it cannot make a file's own `true` key go away.
  // So enabling a skill that the file itself disables has to clear that one line,
  // otherwise the switch would report success and change nothing.
  if (enabled && !skillDisabled.has(name) && row.modelInvocable === false && typeof row.path === 'string') {
    clearFrontmatterDisable(row.path)
  }

  const previous = new Set(skillDisabled)
  if (enabled) skillDisabled.delete(name)
  else skillDisabled.add(name)
  saveSkillDisabled()
  try {
    host.skillShadows?.syncAll?.()
  } catch {
    /* verification below reports what the catalog actually sees */
  }
  await refreshSkillCatalog(host)
  let after
  try {
    after = await skillsState(host, sessionId, signal)
  } catch {
    after = undefined
  }
  const applied = after?.skills?.find((skill) => skill.name === name)?.modelInvocable === enabled
  if (!applied) {
    // A switch the catalog did not take must not survive in the file either.
    skillDisabled = previous
    saveSkillDisabled()
    try {
      host.skillShadows?.syncAll?.()
    } catch {
      /* nothing left to sync */
    }
  }
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

/** Write one name into the disabled set. The filter reads it on the next assembly. */
function setPromptDisabled(host, name, enabled) {
  if (enabled) promptDisabled.delete(name)
  else promptDisabled.add(name)
  savePrompts(promptDisabled)
}

/**
 * Flip one prompt section off/on, then PROVE the switch took effect.
 *
 * The panel still VERIFIES its own work against a fresh assembly and rolls back on
 * failure, because a switch that springs back is exactly the failure it exists to
 * make visible. What changed is which failures remain possible: removing a section
 * from the assembled list works regardless of which layer registered it, so the
 * only remaining case is a `complete: true` section, which the harness re-imposes
 * after the waterfall.
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
    // A `complete: true` section is re-imposed by `SystemPrompt.assemble` after the
    // waterfall, so no listener can remove it; that (and only that) still reports as
    // un-applied rather than springing back silently.
    if (!enabled && afterRow !== undefined && afterRow.liveChars > 0) {
      failure = 'this section is marked complete and is re-imposed by the harness after assembly; it cannot be switched off here'
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

/** Put every disabled section back: clear the set. */
async function resetPromptSections(host, sessionId, signal) {
  promptDisabled.clear()
  savePrompts(promptDisabled)
  return promptsState(host, sessionId, signal)
}

// --- prompt sections ----------------------------------------------------------

/**
 * Remove the disabled prompt sections from the assembled system prompt.
 *
 * WHY THIS REPLACES THE PER-AGENT SHADOW
 *   The previous mechanism registered an empty same-name section into each live
 *   agent's own scope, relying on "nearest layer wins" plus `renderPrompt` dropping
 *   empty text. That only works when the section being hidden lives in an ANCESTOR
 *   layer — exactly the same own-layer exemption that made `tools.restrict()` fail
 *   for agent-local tools. A section the agent registered itself could not be
 *   shadowed from its own layer, so the route had to answer 409 "this section is
 *   registered inside the agent itself and cannot be shadowed from this panel".
 *
 *   Filtering the assembled list has no layer to be wrong about: a name in the
 *   disabled set is removed wherever it was registered.
 *
 * EQUIVALENCE WITH THE OLD MECHANISM
 *   `renderPrompt` is
 *   `assembly.sections.map(render).filter((text) => text.length > 0).join("\n\n")`,
 *   so a section whose text is empty contributes nothing. Deleting the section and
 *   blanking its text therefore render identically; the difference is only that
 *   deletion also works for sections the shadow could not reach.
 *
 * THE ONE THING IT CANNOT DO
 *   `SystemPrompt.assemble` re-imposes a `complete: true` section AFTER the
 *   waterfall returns, so a complete section is outside this listener's reach —
 *   there can be at most one, and blanking the prompt wholesale is not a switch
 *   any panel should own. That case still reports a failure to the caller.
 * @returns the assembly, with disabled sections removed.
 */
function createPromptFilter() {
  return (assembly, _context, next) =>
    Promise.resolve(next()).then((resolved) => {
      if (promptDisabled.size === 0) return resolved
      const sections = resolved?.sections
      if (!Array.isArray(sections)) return resolved
      const kept = sections.filter((section) => !promptDisabled.has(section?.name))
      if (kept.length === sections.length) return resolved
      return { ...resolved, sections: kept }
    })
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
  return [...new Set([...visible, ...denySetFor()])].sort()
}

/**
 * How many of the denied names are really gone from this session's registry view.
 *
 * A sanity gauge rather than a policy input. `schemas(agent)` is the registry view,
 * which the schema filter does not rewrite — the filter runs later, at assembly. So a
 * denied name still appearing here is EXPECTED for its own layer's tools; what the
 * number catches is the opposite, surprising case: a name vanishing from the registry
 * for some other reason (its plugin unloaded), which would make a switch look
 * effective when it is merely unmounted.
 */
function maskedCount(sessionId, host) {
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
 * The snapshot the control renders.
 *
 * The deny list is GLOBAL, so `sessionId` no longer selects a policy — it only
 * selects which session's visible tool list is reported, so the menu still shows
 * exactly the tools that conversation can call.
 */
function snapshot(sessionId, host) {
  return {
    protocol: PROTOCOL,
    sessionId,
    tools: host === undefined ? [...denied].sort() : toolsForSession(sessionId, host),
    denied: [...denied].sort(),
    // Diagnostics, not UI: how many denied names are really gone from the model's
    // schema list. The filter is process-wide now, so there is no per-agent scope
    // count or mount error left to report.
    masked: host === undefined ? undefined : maskedCount(sessionId, host),
    // The user's groups, copied so a caller cannot mutate the live definitions.
    groups: groups.map((group) => ({ id: group.id, name: group.name, members: [...group.members] })),
    blocked,
    last: lastDenial
  }
}

/**
 * Replace the denied set, persist it, then re-apply hiding to every live agent.
 *
 * The list is replaced wholesale rather than patched per name: the control already
 * knows the complete set, a whole-list write is idempotent, and two windows racing
 * on one name cannot leave a half-updated list behind.
 */
function setDeny(names) {
  denied = new Set(names)
  saveTools()
  // No re-apply step: the schema filter reads `denied` on every assembly, so the
  // next model step already sees the new set.
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
    // The deny list is global, so the edit applies to every live agent at once.
    setDeny(names)
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
  // The skills tab's other half: a same-name runtime registration with both
  // invocation flags off, mounted inside each live agent's scope. It is what makes
  // the runtime skills (plugin-injected, bundled) switchable at all — they have no
  // SKILL.md to edit.
  const skillShadows = createSkillShadows(ctx, ctx.get('agents'))
  ctx.effect(() => () => skillShadows.dispose(), 'tools-panel: skill shadows')

  ctx.effect(() => ctx.tools.guard(makeGuard()), 'tools-panel: live guard')

  // Hiding, both tabs, one listener each. Registered on THIS context with no scope,
  // which the waterfall dispatch treats as matching every scope: one listener covers
  // all live agents and every agent created later, so there is nothing to mount per
  // agent and nothing to release when one is disposed.
  ctx.effect(
    () => ctx.on('system-prompt/assemble', createSchemaFilter()),
    'tools-panel: schema filter'
  )
  ctx.effect(
    () => ctx.on('system-prompt/assemble', createPromptFilter()),
    'tools-panel: prompt section filter'
  )

  const agents = ctx.get('agents')
  if (agents !== undefined) {
    ctx.effect(
      () => ctx.on('agent/created', ({ agent }) => {
        skillShadows.mount(agent)
      }),
      'tools-panel: agent mounts'
    )
    ctx.effect(
      () => ctx.on('agent/disposed', ({ agent }) => {
        skillShadows.release(agent.id)
      }),
      'tools-panel: agent cleanup'
    )
    for (const agent of agents.list()) skillShadows.mount(agent)
    // A skill switched off before this process had any agent must apply now.
    skillShadows.syncAll()
  }

  const deps = {
    tools: ctx.tools,
    agents,
    skillShadows,
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
  createPromptFilter,
  createSchemaFilter,
  ROUTE,
  SKILLS_ROUTE,
  cleanDeny,
  createSkillShadows,
  denyReason,
  denySetFor,
  groupsFile,
  loadGroups,
  loadPrompts,
  loadSkillDisabled,
  loadTools,
  makeGuard,
  normalizeGroups,
  normalizePromptNames,
  promptsFile,
  promptsState,
  saveGroups,
  savePrompts,
  saveSkillDisabled,
  saveTools,
  setDeny,
  skillsFile,
  skillsState,
  snapshot,
  togglePromptSection,
  toggleSkill,
  resetPromptSections,
  toolsFile,
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

/** Test-only: the live disabled-skill names. */
export function getSkillDisabled() {
  return [...skillDisabled].sort()
}

/** Test-only: replace the live disabled-skill set without touching disk. */
export function replaceSkillDisabled(names) {
  skillDisabled = new Set(normalizePromptNames(names))
}

/** Test-only: the live denied tool names. */
export function getToolDisabled() {
  return [...denied].sort()
}

/** Test-only: replace the live denied set without touching disk. */
export function replaceToolDisabled(names) {
  denied = new Set(normalizePromptNames(names))
}

/** Test-only: how many calls the guard has refused. */
export function getToolBlocked() {
  return blocked
}

/** Test-only: the last refusal the guard recorded. */
export function getToolLast() {
  return lastDenial
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
