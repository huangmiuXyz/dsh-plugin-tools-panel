/**
 * Tool panel, host half: a live, GLOBAL, PER-TOOL kill-switch.
 *
 * WHAT THE SWITCH IS
 *   The profile carries a DENY SET of tool names. Nothing else: there are no kinds,
 *   no groups, and no built-in table of which tool belongs to which group. The set
 *   is edited by the composer control and read by this half on every registration,
 *   so the next model step already sees it — no reload, no restart.
 *
 * TWO MECHANISMS, ON PURPOSE
 *   1. HIDING (`ctx.tools.restrict()`, applied PER AGENT). The denied tools are
 *      removed from the scope's visible set, so they are not in the schema list the
 *      model is handed, cannot be looked up, and cannot be executed. This is the
 *      primary mechanism: the model does not see the tool, so it does not call it,
 *      and the request is smaller.
 *
 *      WHY NOT `system-prompt/assemble`, WHICH THIS PLUGIN USED TO FILTER
 *      It did, until Harness 0.2.2 moved tool declarations out of the presentation
 *      waterfall: `assemble()` now returns sections, contexts and variables, and the
 *      docs say it plainly — "the returned text is authoritative; tool declarations
 *      remain provider-owned". The old filter read `resolved.tools`, found
 *      `undefined`, and returned the assembly untouched: the switch looked live while
 *      the model was still offered every tool. `restrict()` is the documented hiding
 *      hook again, so it is what this plugin uses.
 *
 *      THE ONE THING IT CANNOT DO. `restrict()` masks what a scope INHERITS; a
 *      scope's OWN registrations stay visible, and naming one fails with "unknown
 *      global tool". That exemption is deliberate — the delegation runtime registers
 *      `subagent`, `team_task_*` and friends into the agent's own layer so a
 *      per-child capability filter cannot strip them. Those names are therefore
 *      reported as LOCKED: the panel draws them, says why they cannot be switched,
 *      and never lets them into the deny set. A switch that does nothing is worse
 *      than no switch.
 *
 *   2. GUARDING (`ctx.tools.guard()`). A backstop, and deliberately kept. The
 *      restriction only shapes what the MODEL is shown and can look up; it cannot
 *      stop a call that arrives from conversation history or from a resumed session
 *      whose header predates the switch. The guard is a SYNCHRONOUS monotonic check
 *      in the execution pipeline, so such a call is refused with a reason the model
 *      can read even when the schema no longer lists it.
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
 *   The set is applied to each agent's own scope at `agent/created` and re-applied
 *   to every live agent whenever it changes, which is why a switch reaches a session
 *   that is already running.
 *
 *   A call with NO agent is governed by the guard alone: there is no scope to
 *   restrict and nothing to hide.
 *
 * WHAT POPULATES THE LIST
 *   The control lists the tools the session can actually see, read from the
 *   registry's view of that agent (`ctx.tools.view(agent)`), post-restriction.
 *   Nothing is hard-coded here: an MCP server or a third-party plugin that registers
 *   a tool shows up in the menu by itself, and uninstalls disappear from it. The
 *   names that are currently denied are always listed too: hiding removed them from
 *   the view, and without them a denied tool could never be re-enabled.
 *
 * PERSISTENCE
 *   The deny set is DURABLE and global: one file under `DSH_HOME`, written on every
 *   change and read back at load. A switch survives a restart, exactly like a
 *   disabled skill or a disabled prompt section.
 *
 * GROUPS
 *   A user can name a set of tools and get one row for it. Groups are
 *   PRESENTATION AND BULK ACTION ONLY: a group has no policy of its own, so the
 *   truth is still per-tool. Turning a group off denies its hideable members;
 *   turning it back on allows them. A tool may belong to several groups, which is why
 *   the group row's switch is derived (all hideable members denied? then it reads
 *   off) rather than stored. LOCKED members are skipped by every bulk action and are
 *   never counted as "off", because they cannot be off.
 *
 *   Group definitions are DURABLE and global (one file under `DSH_HOME`), because
 *   they are the user's organization of their own tool list.
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
 *
 * 9 changed WHERE the reported tool list comes from — the assembled catalog
 * instead of the registry view.
 *
 * 11 added PROGRESSIVE DISCLOSURE: a group may be `deferred`, which withholds its
 * members from the tool list behind a `get_tools` call. The snapshot grew
 * `groups[].disclosure`/`.prompt` and a session-scoped `unlocked` list.
 *
 * 10 is the RESTRICTION REVISION. Harness 0.2.2 moved tool declarations out of the
 * presentation waterfall, so the protocol-9 hiding filter became a no-op; hiding is
 * `ctx.tools.restrict()` again, applied per agent. That changed the shape the model
 * can actually act on: the snapshot grew `locked` (names registered in the agent's
 * own scope, which no restriction can remove), and a client must render those as
 * read-only or it will offer switches that cannot work.
 */
const PROTOCOL = 11

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
    // PROGRESSIVE DISCLOSURE: a deferred group's tools are withheld from the model
    // until the conversation asks for them. `prompt` is the user's own one-line
    // description, which is what the index line in the system prompt says instead of
    // the tool schemas. Only written when deferred, so existing files do not churn.
    const disclosure = entry.disclosure === 'deferred' ? 'deferred' : 'always'
    if (disclosure === 'deferred') {
      const prompt = typeof entry.prompt === 'string' ? entry.prompt.trim().slice(0, MAX_GROUP_PROMPT) : ''
      groups.push({ id, name, members, disclosure, prompt })
    } else {
      groups.push({ id, name, members })
    }
  }
  return groups
}

// --- skills and prompt sections (protocol 8) ----------------------------------

/** How much of one prompt section the browser receives for its preview. */
const MAX_SECTION_TEXT = 4000
/** How much of one skill description the browser receives. */
const MAX_SKILL_DESCRIPTION = 1000
/** Bound on a group's disclosure prompt: it is prompt text, not a document. */
const MAX_GROUP_PROMPT = 400
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
 * What the registry says about one agent's tools, or undefined when it cannot say.
 *
 * `view(scope)` is the registry's own derivation, and the only place the three
 * facts this plugin needs exist together: `visible` (what the model is handed,
 * after every restriction), `knownNames` (everything this scope could use, its own
 * layer included) and `restrictableNames` (the inherited ones — the only names
 * `restrict()` accepts, and the reason LOCKED exists at all).
 */
function toolboxView(host, agent) {
  try {
    const view = host?.tools?.view?.(agent)
    if (view !== undefined && view !== null) return view
  } catch {
    /* a registry that cannot answer leaves the caller on its fallback */
  }
  return undefined
}

/** agentId -> the exact disposer of that agent's restriction. */
const restrictors = new Map()

/**
 * agentId -> the names its live restriction was built from.
 *
 * `restrict()` appends to a layer, and EVERY layer change emits `tools/change`, so
 * re-applying on that event without this would tear the restriction down and put it
 * back on its own notification — the oscillation the old implementation shipped.
 * The signature makes the sweep idempotent: an unchanged answer is no work at all.
 */
const appliedSignatures = new Map()

/** Lift one agent's restriction, if any. Safe to call twice. */
function releaseRestriction(agentId) {
  appliedSignatures.delete(agentId)
  failedNames.delete(agentId)
  const dispose = restrictors.get(agentId)
  if (dispose === undefined) return
  restrictors.delete(agentId)
  try {
    dispose()
  } catch {
    /* already disposed with the agent's own scope */
  }
}

/** Release every agent's restriction (plugin teardown). */
function releaseAll() {
  for (const agentId of [...restrictors.keys()]) releaseRestriction(agentId)
}

/**
 * The names this agent could hide, or undefined when the registry cannot say.
 *
 * An EMPTY set is treated as "cannot say" rather than "nothing is hideable": if the
 * registry reports no inherited contribution at all, the honest reading is that this
 * host did not answer, and acting on it would either hide nothing or (worse) declare
 * every tool locked and prune the user's whole deny set.
 */
function restrictableFor(host, agent) {
  const names = toolboxView(host, agent)?.restrictableNames
  if (!(names instanceof Set) || names.size === 0) return undefined
  return names
}

/**
 * The names one agent holds but NO restriction can remove: its own layer.
 *
 * Reported to the control so it can draw them as read-only instead of offering a
 * switch that silently cannot work. Empty when the registry cannot answer, so an
 * older host degrades to "everything looks switchable" rather than "nothing does".
 * @returns the sorted names.
 */
export function lockedFor(host, agent) {
  if (agent === undefined) return []
  const view = toolboxView(host, agent)
  if (view === undefined) return []
  const known = view.knownNames
  const hideable = view.restrictableNames
  if (!(known instanceof Set) || !(hideable instanceof Set)) return []
  // Nothing restrictable means the registry did not answer usefully; claiming every
  // tool is locked would wipe the deny set on the next sweep.
  if (hideable.size === 0) return []
  return [...known].filter((name) => !hideable.has(name)).sort()
}

// --- progressive disclosure ---------------------------------------------------

/**
 * agentId -> the deferred groups this conversation has asked for.
 *
 * In memory on purpose: an unlocked group must not survive the conversation it was
 * unlocked in. A new session — or a restart — starts with every deferred group
 * closed again, which is the whole point of deferring it.
 */
const unlockedGroups = new Map()

/** The group ids one agent has unlocked (never mutated by a caller). */
function unlockedFor(agentId) {
  return unlockedGroups.get(agentId) ?? new Set()
}

/** Register (or lift) the `get_tools` tool to match the current group definitions. */
let getToolsDispose

function deferredGroups() {
  return groups.filter((group) => group.disclosure === 'deferred')
}

/**
 * The member names a deferred group withholds from one agent.
 *
 * These are NOT denied: the guard must not refuse them (they are ordinary tools the
 * user never switched off), only hide them until the conversation asks. That is why
 * they live in `applyHiding`'s name set rather than in the deny set.
 */
function deferredNamesFor(agent) {
  const open = unlockedFor(agent?.id)
  const names = new Set()
  for (const group of deferredGroups()) {
    if (open.has(group.id)) continue
    for (const name of group.members) names.add(name)
  }
  return names
}

/** Resolve the `group` argument of `get_tools`: id first, then exact name. */
function deferredGroupBy(value) {
  const key = typeof value === 'string' ? value.trim() : ''
  if (key.length === 0) throw new Error('`group` is required: give a deferred group\'s id or exact name')
  const list = deferredGroups()
  const byId = list.find((group) => group.id === key)
  if (byId !== undefined) return byId
  const lowered = key.toLowerCase()
  const byName = list.filter((group) => group.name.toLowerCase() === lowered)
  if (byName.length === 1) return byName[0]
  const known = list.map((group) => `"${group.name}"`).join(', ')
  throw new Error(
    byName.length > 1
      ? `several deferred groups are named "${key}"; pass one id instead: ${byName.map((g) => g.id).join(', ')}`
      : `no deferred group matches "${key}"; deferred groups: ${known.length === 0 ? '(none)' : known}`
  )
}

/** The tool a conversation calls to pull a deferred group into its tool list. */
const GET_TOOLS = {
  name: 'get_tools',
  description:
    'Load a DEFERRED tool group into this conversation. Deferred groups are listed in the system ' +
    'prompt with their name and the user\'s description, but their tools are not in your tool list. ' +
    'Call this with one group name or id; the tools arrive on the next step. Calling it again for ' +
    'a group you already loaded is harmless.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['group'],
    properties: {
      group: { type: 'string', description: 'The deferred group\'s id or exact name.' }
    }
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'message'],
      properties: {
        ok: { type: 'boolean' },
        message: { type: 'string' }
      }
    },
    render(_args, value) {
      return [{ type: 'text', text: value.message }]
    }
  },
  async execute(args, exec) {
    const group = deferredGroupBy(args?.group)
    const agent = exec?.agent
    if (agent?.id === undefined) throw new Error('get_tools needs a live conversation to unlock into')
    let open = unlockedGroups.get(agent.id)
    if (open === undefined) {
      open = new Set()
      unlockedGroups.set(agent.id, open)
    }
    const already = open.has(group.id)
    open.add(group.id)
    // Re-apply immediately so the next assembly already carries the tools.
    applyHidingToAll(panelHost)
    return {
      ok: true,
      message: already
        ? `Group "${group.name}" was already loaded; its ${group.members.length} tool(s) are available.`
        : `Loaded group "${group.name}": ${group.members.length} tool(s) will be available from your next step.`
    }
  }
}

/**
 * Keep the `get_tools` registration in step with the group definitions.
 *
 * The tool only exists while something is deferred, because a menu entry for
 * "unlock a group" with nothing to unlock is a schema paid for by every request and
 * worth nothing.
 */
function syncGetTools(tools) {
  const wanted = deferredGroups().length > 0
  if (wanted && getToolsDispose === undefined) {
    try {
      const dispose = tools.register(GET_TOOLS)
      getToolsDispose = typeof dispose === 'function' ? dispose : () => {}
    } catch {
      /* a registry that refuses leaves the groups deferred and locked, stated in the index line */
    }
  } else if (!wanted && getToolsDispose !== undefined) {
    try {
      getToolsDispose()
    } catch {
      /* already gone */
    }
    getToolsDispose = undefined
  }
}

/** The index line each deferred group contributes to the system prompt. */
function deferredIndexText() {
  const list = deferredGroups()
  if (list.length === 0) return ''
  const lines = [
    'Deferred tool groups — their tools are NOT in your tool list yet. Call `get_tools` with a group name to load one:'
  ]
  for (const group of list) {
    const prompt = (group.prompt ?? '').length > 0 ? ` — ${group.prompt}` : ''
    lines.push(`- ${group.name} (${group.members.length} tools)${prompt}`)
  }
  return lines.join('\n')
}

/**
 * Apply the live deny set to ONE agent.
 *
 * The restriction is registered on the AGENT's context, which is the only context
 * `restrict()` accepts: an unscoped call is refused outright ("would mask every
 * agent"), and registering it per agent is what keeps the profile-wide set local to
 * a scope the registry can derive.
 *
 * Names the registry cannot mask are filtered OUT OF THE CALL, not out of the deny
 * set: the set is the user's decision and must survive a moment when a tool is not
 * registered (an MCP server reconnecting), so the switch still holds when it comes
 * back.
 * @param host - `{ tools }`.
 * @param agent - the live agent.
 */
function applyHiding(host, agent) {
  if (agent === undefined || agent.id === undefined) return
  // `agent.ctx.tools` is the traced service bound to this agent, which is what makes
  // `scopeOf(this.ctx)` resolve to the agent inside `restrict()`. The `get` fallback
  // covers a context whose service property is not proxied yet.
  const scopeTools = agent.ctx?.tools ?? agent.ctx?.get?.('tools')
  if (scopeTools === undefined || typeof scopeTools.restrict !== 'function') return
  // Denied (the kill switch) plus everything a deferred group is still withholding.
  const names = [...new Set([...denied, ...deferredNamesFor(agent)])].sort()
  const failed = failedFor(agent.id)
  const todo = names.filter((name) => !failed.has(name))
  // The signature is the REQUEST plus which names the registry has already refused:
  // a partial mask (the scope was still filling up when we asked) must NOT look like
  // a finished one, or the remaining names are never retried and stay visible for
  // the first step of every turn.
  const signature = `${names.join('\n')}|${failed.size}|${unlockedFor(agent.id).size}`
  if (appliedSignatures.get(agent.id) === signature) return
  // Register the NEW mask before lifting the old one: masks intersect, so an
  // overlapping moment hides the same names twice, while lifting first would open a
  // window in which a step could be assembled with nothing hidden.
  const { disposes, refused } = names.length === 0 ? { disposes: [], refused: [] } : restrictBisect(scopeTools, todo)
  releaseRestriction(agent.id)
  // Re-fetch: releasing cleared this agent's refusals, and the signature has to
  // record the failures THIS attempt found — otherwise a refused name looks like a
  // finished job and is never retried once it finally registers.
  const refusals = failedFor(agent.id)
  for (const name of refused) refusals.add(name)
  if (disposes.length > 0) {
    restrictors.set(agent.id, () => {
      for (const dispose of disposes) {
        try {
          dispose()
        } catch {
          /* already gone with the agent's scope */
        }
      }
    })
  }
  appliedSignatures.set(agent.id, `${names.join('\n')}|${refusals.size}`)
}

/**
 * Register one deny mask, splitting it when the registry refuses.
 *
 * `restrict()` is ALL-OR-NOTHING: it validates every name and throws "unknown global
 * tool" for the first one it cannot mask. Bisecting turns one bad name into a
 * partial mask that still hides everything else, and reports the names that could
 * not be masked so the caller can retry later instead of recording a finished job.
 * @returns the live disposers and the refused names.
 */
function restrictBisect(scopeTools, names) {
  if (names.length === 0) return { disposes: [], refused: [] }
  try {
    const dispose = scopeTools.restrict({ deny: names })
    return { disposes: typeof dispose === 'function' ? [dispose] : [], refused: [] }
  } catch {
    if (names.length === 1) return { disposes: [], refused: names }
    const middle = Math.ceil(names.length / 2)
    const left = restrictBisect(scopeTools, names.slice(0, middle))
    const right = restrictBisect(scopeTools, names.slice(middle))
    return {
      disposes: [...left.disposes, ...right.disposes],
      refused: [...left.refused, ...right.refused]
    }
  }
}

/** The live `{ tools, agents }` handle, set when the plugin is applied. */
let panelHost

/** The last registry content a sweep was run for, shared across agents. */
let lastRegistrySignature = ''

/**
 * Everything the registry holds for the live agents, independent of restrictions.
 *
 * Used only to answer "did the registry really change", because `tools/change` also
 * fires for our own masks — the difference between one sweep and an infinite loop.
 */
function registrySignature(host) {
  const agents = host?.agents
  if (agents === undefined || typeof agents.list !== 'function') return ''
  const names = new Set()
  try {
    for (const agent of agents.list()) {
      const view = toolboxView(host, agent)
      if (view?.knownNames instanceof Set) for (const name of view.knownNames) names.add(name)
    }
  } catch {
    return ''
  }
  return [...names].sort().join('\n')
}

/** agentId -> names the registry refused to mask. Cleared whenever the registry changes. */
const failedNames = new Map()

function failedFor(agentId) {
  let set = failedNames.get(agentId)
  if (set === undefined) {
    set = new Set()
    failedNames.set(agentId, set)
  }
  return set
}

/**
 * Drop LOCKED names from the deny set.
 *
 * A name can only be locked by a LIVE agent. A set persisted by an older build (or by
 * a moment when the name was still inherited) can still carry one, and the guard
 * would then refuse a tool the panel draws as read-only. Read-only means not denied.
 * @returns true when the set changed (and was rewritten to disk).
 */
function pruneLocked(host) {
  const agents = host?.agents
  if (agents === undefined || typeof agents.list !== 'function') return false
  const locked = new Set()
  try {
    for (const agent of agents.list()) {
      for (const name of lockedFor(host, agent)) locked.add(name)
    }
  } catch {
    return false
  }
  if (locked.size === 0) return false
  const kept = [...denied].filter((name) => !locked.has(name))
  if (kept.length === denied.size) return false
  denied = new Set(kept)
  saveTools()
  return true
}

/** Apply the live deny set to every live agent. */
function applyHidingToAll(host) {
  const agents = host?.agents
  if (agents === undefined || typeof agents.list !== 'function') return
  try {
    // Before re-applying: a name that turned out to be locked must leave the set,
    // or the guard would keep refusing a tool the control now draws as read-only.
    pruneLocked(host)
    for (const agent of agents.list()) applyHiding(host, agent)
  } catch {
    /* a registry mid-teardown ends the sweep, not the plugin */
  }
}

// --- skills (protocol 8) ------------------------------------------------------

/** The live agent for one session, or undefined when the session is not running. */
function agentFor(host, sessionId) {
  try {
    const direct = host?.agents?.get?.(sessionId)
    if (direct !== undefined) return direct
    // Fallback: the registry keys by agent id, which is not always the string the
    // browser has. Scanning is cheap (a handful of agents) and turns a silent empty
    // panel into a working one.
    for (const agent of host?.agents?.list?.() ?? []) {
      if (agent?.id === sessionId || agent?.session?.id === sessionId) return agent
    }
  } catch {
    /* a registry that cannot answer leaves the caller with an empty list */
  }
  return undefined
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

/**
 * Assemble one agent's prompt AND tool catalog, through the same context shape the
 * loop uses.
 *
 * `scope: agent` is what the waterfall's scope filter walks up from, so every
 * listener the preset and this plugin registered sees the same assembly the next
 * model step would get — including ones that drop tools after the registry has
 * contributed them.
 */
async function assembleFor(host, agent, signal) {
  const systemPrompt = host?.systemPrompt
  if (systemPrompt === undefined || typeof systemPrompt.assemble !== 'function') {
    throw new PanelError(409, 'the systemPrompt service is unavailable in this deployment')
  }
  return systemPrompt.assemble({ agent, scope: agent, ...(signal === undefined ? {} : { signal }) })
}

/** Assemble one agent's prompt sections, through the same context shape the loop uses. */
async function assembleSections(host, agent, signal) {
  const assembly = await assembleFor(host, agent, signal)
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
 * The registry's view of one agent's tools, after every restriction.
 *
 * `schemas(agent)` is the model-facing list now: Harness 0.2.2 keeps tool
 * declarations out of the presentation waterfall entirely, so a restriction applied
 * through `ctx.tools.restrict()` is the last word on what the model is offered. The
 * blank preset's "no tools" session falls out of the same call — an empty scope has
 * nothing to project — rather than needing a special case.
 */
function registryToolNames(host, agent) {
  const names = []
  try {
    for (const schema of host.tools.schemas(agent)) {
      if (typeof schema?.name === 'string' && schema.name.length > 0) names.push(schema.name)
    }
  } catch {
    /* a registry that cannot answer leaves the denied names below */
  }
  return names
}

/**
 * Tool names the session can see, plus every name it has denied.
 *
 * The denied names are unioned in because hiding is exactly what removes them from
 * the visible set — without the union the control could only ever switch tools OFF,
 * and a name denied while its tool was unregistered (an MCP server reconnecting)
 * could never be switched back on. A denied name that is no longer in the registry
 * stays listed for the same reason.
 *
 * NO FALLBACK TO THE GLOBAL VIEW. An empty answer is the truthful answer for a
 * session that can call nothing; the menu shows "no tools" instead of inventing rows
 * for every process-wide tool.
 * @param sessionId - the conversation's session.
 * @param host - `{ tools, agents }`.
 * @returns the sorted union of the session's visible tools and its denied names.
 */
function toolsForSession(sessionId, host) {
  const agent = agentFor(host, sessionId)
  const visible = agent === undefined ? [] : registryToolNames(host, agent)
  return [...new Set([...visible, ...denySetFor()])].sort()
}

/**
 * How many of the denied names are really gone from this session's visible set.
 *
 * A sanity gauge rather than a policy input. It now measures the thing the panel
 * exists for: a denied name that still shows up here is a name the restriction could
 * not take, and the honest answer in that case is the `locked` list beside it — never
 * a switch drawn as off over a tool the model is still offered.
 */
/** How many denied names this session's live restriction holds. */
function appliedCountFor(sessionId) {
  const signature = appliedSignatures.get(sessionId)
  if (signature === undefined || signature.length === 0) return 0
  const requested = signature.split('|')[0]
  const refused = Number(signature.split('|')[1] ?? 0)
  if (requested.length === 0) return 0
  return requested.split('\n').length - refused
}

/** Denied names the model can STILL see: the switch did not reach them. */
function leakedNames(sessionId, host) {
  const agent = host.agents?.get?.(sessionId)
  if (agent === undefined || denied.size === 0) return []
  try {
    const visible = new Set(host.tools.schemas(agent).map((schema) => schema.name))
    return [...denied].filter((name) => visible.has(name)).sort()
  } catch {
    return []
  }
}

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
 * The deny list is GLOBAL, so `sessionId` does not select a policy — it selects which
 * session's visible tool list and LOCKED names are reported, so the menu shows
 * exactly the tools that conversation can call and which of them it may switch.
 *
 * `locked` is the honesty field: names registered in this agent's own scope. No
 * restriction can remove them, so the control must draw them read-only; a switch
 * there could only ever bounce back.
 * @param sessionId - the conversation whose agent answers for the lists.
 * @param host - `{ tools, agents }`.
 */
async function snapshot(sessionId, host) {
  const agent = host === undefined ? undefined : agentFor(host, sessionId)
  const tools = host === undefined ? [...denied].sort() : toolsForSession(sessionId, host)
  return {
    protocol: PROTOCOL,
    sessionId,
    tools,
    denied: [...denied].sort(),
    locked: host === undefined ? [] : lockedFor(host, agent),
    // Diagnostics: denied names this session can still see. Non-empty means the
    // registry refused to mask them, which is the one thing the panel must not hide.
    leaked: host === undefined ? [] : leakedNames(sessionId, host),
    // How many names this session's live mask holds. A number below `denied.length`
    // is the difference between "the switch is set" and "the switch is applied".
    applied: host === undefined ? 0 : appliedCountFor(sessionId),
    // Diagnostics, not UI: how many denied names are really gone from the model's
    // visible set. A restriction is process-wide per agent, so there is no per-scope
    // mount error left to report.
    masked: host === undefined ? undefined : maskedCount(sessionId, host),
    // The user's groups, copied so a caller cannot mutate the live definitions.
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      members: [...group.members],
      ...(group.disclosure === 'deferred'
        ? { disclosure: group.disclosure, prompt: group.prompt ?? '' }
        : {})
    })),
    // Which deferred groups THIS conversation has already pulled in. Session-scoped
    // and in memory: a restart shows every deferred group closed again.
    unlocked: [...unlockedFor(sessionId)].sort(),
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
function setDeny(names, host) {
  denied = new Set(names)
  saveTools()
  // Restrictions are registered per agent and do NOT re-read the set, so every live
  // agent is re-registered here. That is what makes a switch reach a session that is
  // already running, including the one the user is looking at.
  applyHidingToAll(host)
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
    try {
      sendJson(res, 200, { ok: true, state: await snapshot(sessionId, host) })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
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
  // The disclosure dialog's "unload": put deferred groups back behind `get_tools`
  // for THIS conversation. The counterpart of what the tool unlocks.
  const hasHide = Object.prototype.hasOwnProperty.call(payload, 'hide')
  if (!hasDeny && !hasGroups && !hasHide) {
    sendJson(res, 409, {
      ok: false,
      error:
        `this host speaks tools-panel protocol ${PROTOCOL} and recognizes neither ` +
        `none of \`deny\`, \`groups\` or \`hide\`; it is probably running older code than the page — restart DSH`
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
  if (hasHide) {
    const ids = cleanDeny(payload.hide)
    if (ids === undefined) {
      sendJson(res, 400, { ok: false, error: '`hide` must be an array of group ids' })
      return
    }
    const agent = agentFor(host, sessionId)
    if (agent?.id !== undefined) {
      const open = unlockedGroups.get(agent.id)
      if (open !== undefined) {
        for (const id of ids) open.delete(id)
        applyHidingToAll(host)
      }
    }
  }
  if (hasDeny) {
    const names = cleanDeny(payload.deny)
    if (names === undefined) {
      sendJson(res, 400, { ok: false, error: '`deny` must be an array of tool names' })
      return
    }
    // The deny list is global, so the edit applies to every live agent at once.
    // Names this session's agent cannot hide (its own layer) are refused here rather
    // than stored: a switch the panel drew as read-only must not become a deny entry
    // through a stale page or a hand-written request.
    const locked = new Set(lockedFor(host, agentFor(host, sessionId)))
    setDeny(names.filter((name) => !locked.has(name)), host)
  }
  // The answer reports the state AFTER the write, so a client never has to guess
  // what the host did with its list.
  try {
    sendJson(res, 200, { ok: true, state: await snapshot(sessionId, host) })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
  }
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

  const deps = {
    tools: ctx.tools,
    // A GETTER, not the value read at apply time: this plugin routinely mounts
    // before the agent registry exists, and a captured `undefined` made every route
    // answer "no live agent" — an empty panel with no error to explain it.
    get agents() { return ctx.get('agents') },
    skillShadows,
    // A deferred group withholds tool schemas behind a `get_tools` call.
    get unlockedGroups() { return unlockedGroups },
    // Probed per request, not captured at apply time: a service that appears after
    // this plugin mounts must still answer the tab instead of being reported absent.
    get skills() { return ctx.get('skills') },
    get workingDirectory() { return ctx.get('workingDirectory') },
    get systemPrompt() { return ctx.get('systemPrompt') }
  }

  // ROUTES FIRST. The panel is the user's way back out of a broken switch, so
  // nothing below may be able to take it down: if any later registration throws, the
  // control still answers and can turn the feature off.
  const server = ctx.get('webServer')
  if (server !== undefined) registerRoute(ctx, server, deps)
  else ctx.inject(['webServer'], (scope) => registerRoute(scope, scope.webServer, deps))

  /** Run one registration, and never let it take the plugin (and the panel) down. */
  const attempt = (label, fn) => {
    try {
      fn()
    } catch (error) {
      try {
        ctx.logger?.warn?.(`tools-panel: ${label} disabled itself: ${String(error?.message ?? error)}`)
      } catch {
        /* logging is best-effort */
      }
    }
  }

  attempt('skill shadows', () => ctx.effect(() => () => skillShadows.dispose(), 'tools-panel: skill shadows'))
  attempt('live guard', () => ctx.effect(() => ctx.tools.guard(makeGuard()), 'tools-panel: live guard'))

  // The prompt tab's hiding is still an assemble listener: sections and contexts are
  // exactly what that waterfall owns. The TOOL tab cannot live here any more — tool
  // declarations are provider-owned in 0.2.2 — so it is applied per agent instead.
  attempt('prompt filter', () => ctx.effect(
    () => ctx.on('system-prompt/assemble', createPromptFilter()),
    'tools-panel: prompt section filter'
  ))

  // Probed per CALL rather than captured: a service that appears after this plugin
  // mounts must still be swept, and the registry is the authority on which names
  // `restrict()` accepts.
  const hidingHost = {
    get tools() { return ctx.tools },
    get agents() { return ctx.get('agents') }
  }
  panelHost = hidingHost
  attempt('hiding teardown', () => ctx.effect(() => () => releaseAll(), 'tools-panel: hiding teardown'))

  // The index line that replaces a deferred group's tool schemas in the prompt.
  attempt('deferred index', () => ctx.effect(() => ctx.systemPrompt?.section?.({
    name: 'tools-panel:deferred-groups',
    order: 10250,
    text: () => deferredIndexText()
  }), 'tools-panel: deferred index'))

  // `get_tools` exists only while something is deferred.
  attempt('get_tools', () => {
    ctx.effect(() => () => {
      if (getToolsDispose !== undefined) {
        try {
          getToolsDispose()
        } catch {
          /* already gone */
        }
        getToolsDispose = undefined
      }
    }, 'tools-panel: get_tools teardown')
    syncGetTools(ctx.tools)
  })

  // A tool that registers LATER (an MCP server connecting) has to be hidden by the
  // switch that was already written for it. The restriction is applied per name, so
  // the deny set has to be re-resolved whenever the registry gains or loses a name —
  // deferred to a microtask because the emit happens inside the very change that
  // caused it, and the signature check in `applyHiding` makes the sweep a no-op when
  // nothing actually moved.
  attempt('registry changes', () => ctx.effect(
    () => ctx.on('tools/change', () => {
      // Our own `restrict()` emits this event too. Re-sweeping on it would re-apply
      // the mask, emit again, and spin forever — the freeze this guard exists for.
      // A sweep is only worth doing when the REGISTRY changed, so compare what the
      // registry holds (restrictions are not part of that answer).
      const signature = registrySignature(hidingHost)
      if (signature === lastRegistrySignature) return
      lastRegistrySignature = signature
      queueMicrotask(() => {
        // A refused name is usually just "not registered YET"; a real registry
        // change is the signal to try it again.
        failedNames.clear()
        applyHidingToAll(hidingHost)
      })
    }),
    'tools-panel: registry changes'
  ))

  // THE GUARANTEE. `agent/created` fires while the agent's scope is still being
  // populated, so a restriction computed there can miss tools that register a moment
  // later — which is exactly what "a new session still sees every tool" looks like.
  // Re-checking before every step costs nothing when the signature is unchanged and
  // cannot be raced: the restriction is in place before the schema is assembled.
  attempt('pre-step', () => ctx.effect(
    () => ctx.on('agent/pre-step', (payload, next) => {
      try {
        applyHiding(hidingHost, payload?.agent)
      } catch {
        /* never fail a step over the switch */
      }
      return next()
    }),
    'tools-panel: pre-step hiding'
  ))

  // Registered UNCONDITIONALLY. Profile bundles load concurrently, so `agents` is
  // routinely absent when this plugin mounts; gating the listeners on it meant a
  // process that started early never heard about an agent at all, and the panel
  // answered "no live agent" for a conversation that was plainly running.
  attempt('agent mounts', () => ctx.effect(
    () => ctx.on('agent/created', ({ agent }) => {
      skillShadows.mount(agent)
      // Every agent gets the live deny set the moment it exists, so a switch set
      // before this conversation started applies to it too.
      applyHiding(hidingHost, agent)
    }),
    'tools-panel: agent mounts'
  ))
  attempt('agent cleanup', () => ctx.effect(
    () => ctx.on('agent/disposed', ({ agent }) => {
      skillShadows.release(agent.id)
      releaseRestriction(agent.id)
      unlockedGroups.delete(agent.id)
    }),
    'tools-panel: agent cleanup'
  ))

  /** Mount every agent that already exists — the catch-up pass. */
  const adoptLiveAgents = () => {
    const registry = ctx.get('agents')
    if (registry === undefined || typeof registry.list !== 'function') return
    try {
      for (const agent of registry.list()) {
        skillShadows.mount(agent)
        applyHiding(hidingHost, agent)
      }
    } catch {
      /* a registry mid-teardown ends the pass, not the plugin */
    }
    // A skill switched off before this process had any agent must apply now.
    skillShadows.syncAll()
  }
  attempt('agent catch-up', adoptLiveAgents)
  // ...and again the moment the service finally appears, which is the whole point:
  // `ctx.get()` answers undefined for a service whose fiber is not active yet.
  attempt('agents service', () => ctx.inject(['agents'], () => adoptLiveAgents()))
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
  ROUTE,
  SKILLS_ROUTE,
  cleanDeny,
  createSkillShadows,
  denyReason,
  denySetFor,
  applyHiding,
  applyHidingToAll,
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
  // Disclosure changes reach the model through two things: the `get_tools` tool's
  // existence and the withheld names themselves. Both are host-side, so a group edit
  // from the panel or from `manage_tool_groups` has to re-sync them here.
  if (panelHost !== undefined) {
    syncGetTools(panelHost.tools)
    applyHidingToAll(panelHost)
  }
  return groups
}

/** Test-only: replace the live group definitions without touching disk. */
export function setGroups(next) {
  groups = next
}
