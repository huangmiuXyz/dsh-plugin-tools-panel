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
 *   A model request's tool declarations are the registry's scoped projection
 *   (`ctx.tools.schemas(agent)`; `request/header.tools` in the session log records
 *   that exact list). Both mechanisms act on that projection.
 *
 *   1. HIDING (`ctx.tools.restrict({ deny })`). One restriction fiber mounted inside
 *      each live agent's context, because the contract is scope-bound. The name leaves
 *      the model's tool list, so it is never offered and the request is smaller. This
 *      is the primary mechanism.
 *
 *      SCOPE-LOCAL EXEMPTION: `restrict()` filters what a scope INHERITS and never what
 *      its own layer registers — an exemption the delegation runtime depends on,
 *      because that is how a child gets its own structured-output tools. Every
 *      agent-local tool (`spawn_teammate`, the `team_task_*` family, `wait_agent`, …)
 *      therefore fails the call with "unknown global tool" and STAYS in the model's
 *      list. The snapshot reports those names (`unmaskable`), the catalog filter below
 *      still hides them from the menu, and the guard is what refuses them.
 *
 *      A restriction is an explicit registration, so a changed set must be re-applied
 *      to every mounted scope: `setDeny` and a group load/lock each fire a hook that
 *      re-syncs. Forgetting the load/lock half is exactly what made `get_tools` report
 *      a group as loaded while its tools never reached the request.
 *
 *   2. CATALOG FILTERING (`system-prompt/assemble`). The assembled catalog is a
 *      PRESENTATION view — the panel reads it, the request does not — so this listener
 *      exists to keep that view consistent with the policy and to cover the names
 *      `restrict()` cannot mask. It is registered ONCE on the plugin's own context; the
 *      waterfall dispatch accepts a scope-less listener for every scope, so one listener
 *      covers all live agents and every agent created later.
 *
 *   3. GUARDING (`ctx.tools.guard()`). A backstop, and deliberately kept. Hiding shapes
 *      what the model is offered; it cannot stop a call that arrives from conversation
 *      history, from a resumed session whose header predates the switch, or through a
 *      PTC sub-dispatch. The guard is a SYNCHRONOUS monotonic check in the execution
 *      pipeline, so such a call is refused with a reason the model can read even when
 *      the schema no longer lists it.
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
 *   Nothing has to be re-applied when the set changes for the GUARD (it reads the live
 *   set on every call) or for the catalog filter (it reads it every assembly). The
 *   registry restriction is an explicit registration, so the two policy hooks re-apply
 *   it: {@link onDenyChanged} for a deny write and {@link onUnlockChanged} for a group
 *   load/lock.
 *
 *   A call with NO agent is governed too: the set is global, so there is no session
 *   to consult and nothing to exempt.
 *
 * WHAT POPULATES THE LIST
 *   The control lists the tools the session can actually see, read from the assembled
 *   catalog (`system-prompt/assemble`), with `ctx.tools.schemas(agent)` as the
 *   fallback. Nothing is hard-coded here: an MCP server or a third-party plugin that
 *   registers a tool shows up in the menu by itself, and uninstalls disappear from it.
 *   The names that are currently denied (or deferred) are always listed too: hiding is
 *   what removes them, and without the union they could never be switched back on.
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
 *
 * PROGRESSIVE DISCLOSURE (protocol 10)
 *   A group may OPT IN to being deferred: the user gives it a description prompt and,
 *   while it is deferred, its member tools are hidden from the MODEL'S tool list — the
 *   scoped `restrict()` seam described above (the catalog filter drops them from the
 *   menu's view as well). They cost no context until the model asks for them, and the
 *   only thing left about them is one index line in the system prompt:
 *
 *     1. a `tools-panel:deferred-tools` section naming each still-locked group, its
 *        description prompt and its member count (never the member names), and
 *     2. a `get_tools` tool, registered only while at least one group defers, which
 *        loads one group.
 *
 *   Loading is SESSION-SCOPED AND IN MEMORY: "the model fetched this group" is a fact
 *   about one conversation, so a new conversation (or a restart) starts locked again,
 *   and a subagent inherits its parent's loads through the delegation tree. The group
 *   DEFINITION (whether it defers, and its prompt) is durable and global, like every
 *   other group field. Loading must also LIFT the registry mask in the same call — the
 *   unlock hook does that — or the tools stay hidden even though the index says loaded.
 *
 *   Disclosure is CONTEXT ECONOMY, NOT POLICY: a deferred tool stays callable by name
 *   (it is not denied, and the guard does not refuse it), which is why it is not
 *   merged into `denied` anywhere. Names registered in an agent's OWN layer cannot be
 *   masked at all, so they stay advertised; the snapshot's `unmaskable` diagnostics say
 *   which ones, per session.
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
 * 9 also changed WHERE the reported tool list comes from — the assembled catalog
 * instead of the registry view. That is host-side behaviour with no wire field of
 * its own: an older client already renders an empty list, so it did not need a new
 * number (and did not deserve the restart a bump would force).
 *
 * 10 added PROGRESSIVE DISCLOSURE: a group carries `disclosure`/`prompt`, the
 * snapshot grew `deferred` (this session's hidden member names) and `unlocked` (the
 * group ids it has loaded), and a POST may carry `hide` to lock a group again. A
 * client that does not read those fields would show a deferred group's members as
 * ordinary rows, so the number had to move.
 *
 * 10 also grew host-side DIAGNOSTICS this client ignores: `masked` (hidden names still
 * in the registry view), `scopes` (mounted restriction fibers), `unmaskable` (names the
 * host refused to mask for this session) and `scopesError`. Additive and read-only, so
 * they did not need a number of their own.
 */
const PROTOCOL = 10

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
    groups.push({
      id,
      name,
      members,
      // Progressive disclosure is opt-in per group. Anything that is not exactly
      // `true` reads as off, so a hand-edited file cannot half-enable it.
      disclosure: entry.disclosure === true,
      prompt: normalizeGroupPrompt(entry.prompt)
    })
  }
  return groups
}

/**
 * Validate one group's description prompt.
 *
 * This text is injected into the model's system prompt, so it is bounded and stripped
 * of control characters that would let one entry break the index's line structure. An
 * absent or non-string value is the empty string, not a refusal: a group that has
 * never been given a prompt is ordinary.
 * @returns the cleaned prompt.
 */
function normalizeGroupPrompt(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, MAX_GROUP_PROMPT)
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
      // Resolved per pass: the registry may be provided after this controller was built
      // (profile bundles load concurrently). A captured `undefined` would mean the
      // shadows never mount at all.
      const registry = typeof agents === 'function' ? agents() : agents
      list = registry?.list?.() ?? []
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
 * How long a group's description prompt may be, and how much of it the index carries.
 *
 * Two bounds on purpose: the stored prompt is the user's own text (written for the
 * model), while the index shows only a slice, so one long prompt cannot dominate the
 * system prompt it is meant to save.
 */
const MAX_GROUP_PROMPT = 2000
const MAX_INDEX_PROMPT = 240

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

/**
 * Run after the group list is replaced, so the halves derived from the definitions
 * follow them. `apply` swaps in the live hook; a test-only `setGroups` never calls it,
 * and a deployment that never mounted keeps the no-op.
 */
let onGroupsChanged = () => {}

/**
 * Run after the deny set is replaced, so the mounted restrictions follow it.
 *
 * The two hiding halves disagree about when they need telling. The assembly filter
 * reads `denied` on every assembly and needs nothing; the REGISTRY restriction is an
 * explicit registration and does. `apply` swaps in the live hook.
 */
let onDenyChanged = () => {}

/**
 * Run after a session's LOADED-GROUP set changes, so the mounted restrictions follow it.
 *
 * Same asymmetry as {@link onDenyChanged}, and the reason `get_tools` could report a
 * group as loaded while the tools were missing from the very next request: the mask
 * installed while the group was still deferred is a registration, so unlocking in
 * memory left it in place. The model's declarations come from the registry's scoped
 * projection, not from the assemble waterfall, so without this hook the group was
 * hidden twice and revealed never — and because the names were no longer deferred, the
 * panel stopped listing them too.
 */
let onUnlockChanged = () => {}

// --- progressive disclosure, per session -------------------------------------

/**
 * The disclosure groups a session has unlocked, by group id.
 *
 * SESSION-SCOPED AND IN MEMORY, by design: "the model fetched this group" is a fact
 * about one conversation, not a durable preference, so a new conversation (or a
 * restart) starts with every deferred group locked again. The group DEFINITION
 * (whether it defers, and its description prompt) stays durable with the rest of the
 * group, because that is the user's organization of their own tool list.
 */
const unlocked = new Map()

/**
 * Session -> the agent that created it.
 *
 * Only used to inherit UNLOCKS: a child's tool list must not silently lose a group its
 * parent loaded, or "delegate it to a subagent" would become a way to get the tools
 * back. Unlike the old per-session deny list, this is a lazy read, so a parent's later
 * load still reaches children that already exist.
 */
const parents = new Map()

/** The disclosure groups that actually defer tools: opted in AND non-empty. */
function deferredGroups() {
  return groups.filter((group) => group.disclosure === true && group.members.length > 0)
}

/**
 * Every group id one session has unlocked, unioned up its spawn chain.
 *
 * Union rather than "nearest owner": an unlock is an ADDITION to what the model may
 * see, so a child may widen its own view without widening its parent's, and a parent's
 * unlock must reach the children it delegated to.
 * @param sessionId - the session asking.
 * @returns the unlocked group ids.
 */
function unlockedFor(sessionId) {
  const ids = new Set()
  let current = sessionId
  const seen = new Set()
  while (typeof current === 'string' && !seen.has(current)) {
    seen.add(current)
    const entry = unlocked.get(current)
    if (entry !== undefined) for (const id of entry) ids.add(id)
    current = parents.get(current)
  }
  return ids
}

/** The disclosure groups still locked for one session. */
function lockedGroupsFor(sessionId) {
  const open = unlockedFor(sessionId)
  return deferredGroups().filter((group) => !open.has(group.id))
}

/**
 * The member names hidden ONLY because of progressive disclosure.
 *
 * Kept separate from the deny set because the two mean different things: a denied tool
 * is refused by the guard and shows as "off" in the panel, while a deferred one is
 * merely not advertised — it stays callable by name, and the panel still lists it with
 * its own switch.
 * @param sessionId - the session asking.
 * @returns the deferred names.
 */
function deferredNamesFor(sessionId) {
  const names = new Set()
  for (const group of lockedGroupsFor(sessionId)) {
    for (const name of group.members) names.add(name)
  }
  return names
}

/** Unlock one group for one session and return whether the set changed. */
function unlockGroup(sessionId, groupId) {
  const current = unlocked.get(sessionId)
  if (current !== undefined && current.has(groupId)) return false
  const next = new Set(current ?? [])
  next.add(groupId)
  unlocked.set(sessionId, next)
  // The registry mask must go, or the tools stay hidden forever: see onUnlockChanged.
  onUnlockChanged()
  return true
}

/** Lock one group again for one session (the "hide it again" action). */
function lockGroup(sessionId, groupId) {
  const current = unlocked.get(sessionId)
  if (current === undefined || !current.has(groupId)) return false
  const next = new Set(current)
  next.delete(groupId)
  if (next.size === 0) unlocked.delete(sessionId)
  else unlocked.set(sessionId, next)
  // The counterpart of the unlock: the group's names must be masked again NOW, not on
  // the next policy edit.
  onUnlockChanged()
  return true
}

/**
 * The session an assembly belongs to.
 *
 * `systemPrompt.assemble({ agent, scope: agent })` puts the agent on BOTH fields, and
 * the waterfall hands that context to every listener. Either spelling answers; a
 * context with neither (an assembly outside any agent) has no session to consult, so
 * it sees every deferred group as locked — the honest fallback.
 * @returns the session id, or undefined.
 */
function sessionIdOf(context) {
  const id = context?.agent?.id ?? context?.scope?.id
  return typeof id === 'string' ? id : undefined
}

/**
 * The agent that created one agent, when the registry can say.
 *
 * Used only for unlock inheritance, so an absent or older registry degrades to a flat
 * tree rather than failing anything.
 * @returns the parent session id, or undefined for a root.
 */
function detectParent(agents, child) {
  if (agents === undefined || child === undefined || typeof child.id !== 'string') return undefined
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
 * The catalog filter: remove hidden names from the tool list ONE ASSEMBLY carries.
 *
 * WHAT THIS IS NOT
 *   This is not the enforcement seam. A model request's tool declarations are the
 *   registry's scoped projection (`ctx.tools.schemas(agent)`), which is what
 *   `request/header.tools` in the session log records; the assemble waterfall returns a
 *   PRESENTATION catalog that other prompt consumers and this panel read. Rewriting its
 *   `tools` therefore does not change what the model is offered — the live proof being a
 *   deferred group whose members are registered in the agent's own scope, which stayed in
 *   the request while this filter dropped them.
 *
 *   Enforcement is `ctx.tools.restrict()` per agent scope ({@link createRestrictor}),
 *   because restrictions only filter inherited contributions. This filter runs on
 *   purpose anyway: it keeps the catalog consistent with the policy for the panel and for
 *   any other plugin that reads the assembled catalog, and it covers the scope-local
 *   names that `restrict()` structurally cannot mask.
 *
 * THE HOOK
 *   The hook is registered on the PLUGIN's context, not per agent. `waterfall` is
 *   dispatched through `scopeTarget(this, scope)`, and that filter accepts a listener
 *   registered with no scope for every scope (`tag === void 0` returns true). One
 *   registration therefore covers every agent, including ones created later.
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
  return (assembly, context, next) =>
    Promise.resolve(next()).then((resolved) => {
      // Two reasons a tool is not offered: the user denied it (global), or it belongs
      // to a group this session has not loaded yet (progressive disclosure). The
      // second set is per-session, so the context is what makes it answerable.
      const deferred = deferredNamesFor(sessionIdOf(context))
      // Nothing to hide: hand the assembly back untouched, so the common case costs
      // one identity return and cannot perturb another plugin's work.
      if (denied.size === 0 && deferred.size === 0) return resolved
      const tools = resolved?.tools
      if (!Array.isArray(tools)) return resolved
      const kept = tools.filter((schema) => {
        const name = schema?.name
        return !denied.has(name) && !deferred.has(name)
      })
      // Same length means nothing was hidden for this scope; return the ORIGINAL
      // value so an unchanged request keeps its identity for downstream caching.
      if (kept.length === tools.length) return resolved
      return { ...resolved, tools: kept }
    })
}


// --- per-agent hiding (the registry half) -------------------------------------

/**
 * The names one session must not be offered: the global deny set plus the deferred
 * groups it has not loaded.
 *
 * The assembly filter asks the same question, but only for the CATALOG the panel reads.
 * THIS set is what the registry is asked to remove, because a schema the registry still
 * returns is a schema the loop can still send: a request's tool declarations are built
 * from `tools.schemas(agent)`, not from the assemble waterfall.
 */
function hiddenNamesFor(sessionId) {
  const names = new Set(denied)
  for (const name of deferredNamesFor(sessionId)) names.add(name)
  return names
}

/**
 * Mount a `ctx.tools.restrict()` restriction into every live agent's scope.
 *
 * WHY THE REGISTRY, NOT THE ASSEMBLY
 *   `system-prompt/assemble` is a PRESENTATION waterfall: it shapes the prompt text and
 *   the catalog the panel reads, but the tool DECLARATIONS of a model request are the
 *   registry's scoped projection (`tools.schemas(agent)`) — `request/header.tools` in
 *   the session log is exactly that list. Rewriting `assembly.tools` therefore changes
 *   what the panel shows while the model keeps receiving every schema. The live proof:
 *   a deferred group whose members are registered in the agent's own scope stayed in
 *   the request even while the assembly filter dropped them.
 *
 *   `restrict({ deny })` IS the registry seam, and it is scope-bound on purpose: the
 *   contract refuses an unscoped call ("would mask every agent"), so the only supported
 *   way is a fiber mounted INSIDE the agent's own context. A name the scope may not mask
 *   — one registered in its OWN layer, which is how the delegation runtime hands an
 *   agent `subagent`, `spawn_teammate`, `team_task_*`, … — fails the call. Those stay in
 *   the model's list; for a DENIED name the guard still refuses every call, which is
 *   the documented backstop, and for a DEFERRED name the schema stays advertised (the
 *   context saving is lost, the tool is not).
 *
 * WHY A BISECT
 *   One unacceptable name fails the whole batch, and the error does not say which names
 *   were the problem. Retrying one name at a time costs a round trip per name and emits
 *   `tools/change` per success; halving the list finds the refused names in O(k log n)
 *   calls. The refused names are reported (`unmaskable`) and re-hunted only when the
 *   policy changes, so an unchanged wanted set never touches the registry.
 *
 * The wanted set is read from POLICY (deny + disclosure), never from the live view, so
 * hiding cannot feed itself: `restrict()` emits `tools/change`, and an unchanged wanted
 * set returns before touching the registry. A group load/lock and a deny edit are the
 * events that change it — see `onUnlockChanged` / `onDenyChanged`.
 * @returns the controller used by the agent lifecycle and the routes.
 */
function createRestrictor() {
  /** agent id -> { holder, fiber } */
  const entries = new Map()
  /** Agents whose scope could not take a fiber at all: id -> reason. */
  const unmounted = new Map()
  let live = true

  /** One agent's restriction fiber: it re-reads the policy when asked. */
  function mount(agent) {
    if (!live) return
    const id = agent?.id
    if (typeof id !== 'string' || entries.has(id)) return
    const agentCtx = agent?.ctx
    if (agentCtx === undefined || typeof agentCtx.plugin !== 'function') {
      unmounted.set(id, 'agent scope has no ctx.plugin: hiding unavailable, the guard still refuses calls')
      return
    }
    /**
     * Names this scope refused to mask during the LAST pass, for diagnostics.
     *
     * Not a cache: the registry validates names at call time, so a name refused
     * because it was not registered yet must get another chance after the set changes
     * (an MCP server connecting is the ordinary case). Re-hunting on a policy edit
     * costs a handful of in-process calls and is the only way to tell the two apart —
     * the host's error reports both as "unknown global tools".
     */
    let unmaskable = new Set()
    /** The last thing that went wrong in this scope, if anything. */
    const holder = { sync: () => {}, error: undefined, unmaskable: () => [...unmaskable].sort() }
    const definition = {
      name: 'dsh-plugin-tools-panel:restricted-tools',
      inject: ['tools'],
      apply(c) {
        let stopped = false
        /** The exact wanted set the mounted restriction was built for, `\0`-joined. */
        let applied
        const disposers = []
        const clear = () => {
          for (const off of disposers.splice(0)) {
            try {
              off()
            } catch {
              /* the layer is already gone */
            }
          }
        }
        const sync = () => {
          if (stopped) return
          if (typeof c.tools?.restrict !== 'function') {
            holder.error =
              'ctx.tools.restrict is unavailable in this scope: the model still sees every tool, ' +
              'the guard refuses denied calls'
            return
          }
          const wanted = [...hiddenNamesFor(id)].sort()
          const signature = wanted.join('\u0000')
          // An unchanged wanted set keeps the mounted restriction: rebuilding it would
          // tear down and re-add the same layer, and both directions emit `tools/change`
          // synchronously.
          if (signature === applied) return
          clear()
          applied = signature
          unmaskable = new Set()
          if (wanted.length === 0) {
            holder.error = undefined
            return
          }
          const rejected = []
          /**
           * Restrict one group of names. A failure means at least one name in the group
           * is unacceptable here, so halve until the culprit is a single name: the host
           * does not say which ones it refused.
           */
          const attempt = (names) => {
            try {
              disposers.push(c.tools.restrict({ deny: names }))
            } catch {
              if (names.length === 1) {
                rejected.push(names[0])
                return
              }
              const middle = names.length >> 1
              attempt(names.slice(0, middle))
              attempt(names.slice(middle))
            }
          }
          attempt(wanted)
          if (rejected.length === 0) {
            holder.error = undefined
            return
          }
          for (const name of rejected) unmaskable.add(name)
          holder.error =
            `${rejected.length} hidden name${rejected.length === 1 ? '' : 's'} cannot be masked in this ` +
            `scope (registered in the agent's own layer, or not registered yet): ${rejected.join(', ')}`
        }
        holder.sync = sync
        try {
          c.effect(() => () => {
            stopped = true
            holder.sync = () => {}
            clear()
          })
        } catch {
          /* a minimal context without `effect`: the fiber teardown still runs */
        }
        sync()
      }
    }
    try {
      entries.set(id, { holder, fiber: agentCtx.plugin(definition) })
      unmounted.delete(id)
    } catch (failure) {
      unmounted.set(id, String(failure?.message ?? failure))
    }
  }

  function syncAll() {
    if (!live) return
    for (const entry of entries.values()) {
      try {
        entry.holder.sync()
      } catch (failure) {
        // One dead scope must not stop the rest.
        entry.holder.error = String(failure?.message ?? failure)
      }
    }
    writeHidingReport()
  }

  /**
   * A small file under the panel directory, so "is the restriction actually mounted,
   * and on what" is answerable by opening one JSON file instead of restarting with a
   * debugger. Best effort: a read-only home just skips it.
   */
  function writeHidingReport() {
    try {
      const failures = []
      const agents = []
      for (const [id, entry] of entries) {
        const names = [...hiddenNamesFor(id)].sort()
        const unmaskable = entry.holder.unmaskable()
        agents.push({ id, names, unmaskable })
        if (entry.holder.error !== undefined) failures.push(`${id}: ${entry.holder.error}`)
      }
      for (const [id, reason] of unmounted) failures.push(`${id}: ${reason}`)
      const report = {
        at: new Date().toISOString(),
        agents,
        error: failures.length === 0 ? null : failures.join(' | ')
      }
      const file = join(panelDir(), 'hiding.json')
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    } catch {
      /* diagnostics must never take the switch down */
    }
  }

  return {
    mount,
    syncAll,
    release(id) {
      entries.delete(id)
      unmounted.delete(id)
    },
    dispose() {
      live = false
      for (const entry of entries.values()) {
        try {
          entry.fiber?.dispose?.()
        } catch {
          /* already gone */
        }
      }
      entries.clear()
      unmounted.clear()
    },
    get size() { return entries.size },
    /** The first scope-level failure, for the diagnostics in the snapshot. */
    get error() {
      const first = unmounted.values().next()
      if (first.done !== true) return first.value
      for (const entry of entries.values()) {
        if (entry.holder.error !== undefined) return entry.holder.error
      }
      return undefined
    },
    /** The names this scope could not mask (diagnostics only). */
    unmaskableFor(id) {
      return entries.get(id)?.holder.unmaskable() ?? []
    }
  }
}

// --- progressive disclosure: the index and the fetch tool ---------------------

/** Section name of the deferred-group index in the system prompt. */
const INDEX_SECTION = 'tools-panel:deferred-tools'
/**
 * Sort order of that section.
 *
 * First-party instructions sit below 10100 (harness source, web surface) and the
 * deployment persona suffix is 10200, so 10150 puts the index at the tail of the
 * prompt without claiming the last slot. The value only has to be finite.
 */
const INDEX_ORDER = 10150
/** The model-facing fetch tool. Deliberately the plain name a model expects. */
const GET_TOOLS = 'get_tools'

/**
 * The system-prompt index of one session's still-locked deferred groups.
 *
 * This is the whole point of the description prompt: it is not a note for the UI, it
 * is the line the MODEL reads to decide whether fetching this group is worth a call.
 * One line per group, no tool names — listing the names would hand back the context
 * economy the feature exists to buy.
 *
 * A session id is optional: an assembly without an agent cannot know what was
 * unlocked, and showing every deferred group is the honest fallback (a locked group it
 * already fetched costs one redundant line, not a wrong tool).
 * @param sessionId - the session being assembled, when known.
 * @returns the section text, or '' when nothing is locked (an empty section is dropped
 *   by the renderer, so the prompt is byte-identical with the feature off).
 */
function deferredIndexText(sessionId) {
  const locked = typeof sessionId === 'string' ? lockedGroupsFor(sessionId) : deferredGroups()
  if (locked.length === 0) return ''
  const lines = [
    '## Deferred tool groups',
    'The tools of the groups below are not loaded in this conversation, so they are not in your tool list yet.',
    'Call `get_tools` with a group name or id to load that group: the tools are injected into your tool list',
    'from the next step on, with their own descriptions and parameter schemas, and stay available for the rest',
    'of this conversation.',
    ''
  ]
  for (const group of locked) {
    // Collapse whitespace in BOTH fields: a name or description carrying a newline
    // would otherwise end the `- ` list item early and turn the rest of the prompt into
    // free text the model reads as instructions.
    const name = group.name.replace(/\s+/g, ' ')
    const prompt = truncateText(String(group.prompt ?? '').replace(/\s+/g, ' '), MAX_INDEX_PROMPT)
    const suffix = `${group.members.length} tool${group.members.length === 1 ? '' : 's'}`
    lines.push(`- ${name}${prompt.text.length === 0 ? '' : `: ${prompt.text}`} (${suffix})`)
  }
  return lines.join('\n')
}

/**
 * Resolve one group by id or exact name, case-insensitively.
 * @returns the group, or undefined when nothing matches unambiguously.
 */
function findGroupByName(list, value) {
  const key = value.trim().toLowerCase()
  const byId = list.find((group) => group.id.toLowerCase() === key)
  if (byId !== undefined) return byId
  const matches = list.filter((group) => group.name.toLowerCase() === key)
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * Whether one tool is registered at all (mounted somewhere), through the global view.
 *
 * The scoped registry read below is the model's tool list, which is the truth while the
 * group is loaded. This global view covers the case the scope view cannot answer (no
 * agent, a registry that throws): a name registered process-wide counts as loaded,
 * because that is where an agent inherits it.
 * @returns whether the name is registered, or undefined when there is no registry.
 */
function registeredSomewhere(host, name) {
  if (host?.tools === undefined) return undefined
  try {
    return host.tools.schemas().some((schema) => schema?.name === name)
  } catch {
    return undefined
  }
}

/**
 * How many of a group's members are in the model-facing catalog right now.
 *
 * The ONLY thing `get_tools` counts. It deliberately does not look at a member's
 * description or parameter schema: nothing of the sort travels back to the model (see
 * {@link getToolsDefinition}), so a group whose list is partly unmounted only needs the
 * missing count to report honestly.
 * @param group - the group definition.
 * @param live - the names the calling agent's registry projection carries after the unlock.
 * @param host - the registry, for the global fallback (see `registeredSomewhere`).
 * @returns the member count and how many of them are not in the catalog.
 */
function describeGroup(group, live, host) {
  let mounted = 0
  let missing = 0
  for (const name of group.members) {
    if (live.has(name) || registeredSomewhere(host, name) === true) mounted += 1
    else missing += 1
  }
  return { mounted, missing }
}

/**
 * The `get_tools` definition.
 *
 * The answer is a CONFIRMATION ONLY: no tool name, description or parameter schema
 * comes back. Loading the group puts the REAL tools into the model's tool list from the
 * next step on, where the harness serves their full schemas — repeating them in this
 * answer would copy the very context payloads the feature exists to save, and the model
 * would read each schema twice. So the whole result is one sentence: the tools are
 * injected, and the next step can call them.
 *
 * Registered ONLY while at least one group is deferred (see
 * {@link createDeferredTools}), so a profile that never uses the feature pays no schema
 * for a tool that could never answer anything.
 * @param enable - unlock one group for one session; returns whether it changed.
 * @param names - the calling agent's model-facing tool names, read from the registry
 *   projection after the unlock, so the answer can say how many members actually landed.
 * @param registry - `{ tools }`, read for the global fallback (see `registeredSomewhere`).
 */
function getToolsDefinition({ enable, names, registry }) {
  return {
    name: GET_TOOLS,
    description:
      'Load a deferred (progressively disclosed) tool group into this conversation. The system prompt ' +
      'lists the deferred groups; call this with a group name or id and that group\'s tools are injected ' +
      'into your tool list from the next step on, with their own descriptions and parameter schemas, for ' +
      'the rest of the conversation. The answer is only a confirmation — it returns no schemas. Omit ' +
      '`group` to list the groups. A group loaded here stays available: do not load it again.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        group: {
          type: 'string',
          description:
            'Group name or id, exactly as the system prompt lists it. Omit to list the deferred groups.'
        }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'message', 'groups'],
        properties: {
          ok: { type: 'boolean', description: 'Whether the call was answered.' },
          message: { type: 'string', description: 'One sentence describing what happened.' },
          groups: {
            type: 'array',
            description: 'The groups this answer covers. No tool schema travels here.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'name', 'prompt', 'memberCount', 'unlocked'],
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                prompt: { type: 'string' },
                memberCount: { type: 'number' },
                unlocked: { type: 'boolean' }
              }
            }
          }
        }
      },
      render(args, value) {
        // The message IS the answer, for a catalogue call and for a load alike: once a
        // group is loaded its tools arrive as real tools on the next step, so any
        // further text here would only re-spend the context this feature saves.
        return [{ type: 'text', text: value.message }]
      }
    },
    async execute(args, exec) {
      const input = args ?? {}
      const sessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id : undefined
      const disclosed = deferredGroups()
      if (disclosed.length === 0) {
        return {
          ok: true,
          message: 'No tool group has progressive disclosure enabled, so there is nothing to load.',
          groups: []
        }
      }
      const key = typeof input.group === 'string' ? input.group.trim() : ''
      if (key.length === 0) {
        const open = sessionId === undefined ? new Set() : unlockedFor(sessionId)
        const catalogue = disclosed
          .map((group) => {
            const count = group.members.length
            return `${group.name} (${count} tool${count === 1 ? '' : 's'})${open.has(group.id) ? ' [loaded]' : ''}`
          })
          .join(', ')
        return {
          ok: true,
          message:
            `${disclosed.length} deferred group${disclosed.length === 1 ? '' : 's'}: ${catalogue}. ` +
            'Call again with `group` set to one of them to load its tools.',
          groups: disclosed.map((group) => ({
            id: group.id,
            name: group.name,
            prompt: group.prompt ?? '',
            memberCount: group.members.length,
            unlocked: open.has(group.id)
          }))
        }
      }
      const group = findGroupByName(disclosed, key)
      if (group === undefined) {
        const known = disclosed.map((entry) => `"${entry.name}"`).join(', ')
        throw new Error(`no deferred group matches "${key}"; known groups: ${known}`)
      }
      const wasOpen = sessionId !== undefined && unlockedFor(sessionId).has(group.id)
      const nowOpen = sessionId === undefined || wasOpen
        ? false
        : enable(sessionId, group.id)
      // Read the model's tool list AFTER the unlock. `enable()` lifts the registry mask
      // synchronously through the unlock hook, so this is the honest answer to "did the
      // members land"; reading it before would report the names this very call just
      // revealed as "missing".
      const live = exec?.agent === undefined ? new Set() : names(exec.agent)
      const described = describeGroup(group, live, registry)
      // The answer is the confirmation and nothing else: the schemas arrive with the
      // tools themselves on the next step, so they are not copied into this text.
      const parts = []
      if (described.mounted === 0) {
        parts.push(`Group "${group.name}" has no registered tool right now, so nothing was injected.`)
      } else if (nowOpen) {
        parts.push(
          `Group "${group.name}" is loaded: ${described.mounted} tool${described.mounted === 1 ? '' : 's'} ` +
          'injected into your tool list, available from the next step for the rest of this conversation.'
        )
      } else if (wasOpen) {
        parts.push(
          `Group "${group.name}" was already loaded in this conversation: its ` +
          `${described.mounted} tool${described.mounted === 1 ? '' : 's'} are in your tool list.`
        )
      } else {
        parts.push(
          `Group "${group.name}" was not injected: this call has no session to load it into. ` +
          'The tools stay callable by name.'
        )
      }
      if (described.missing > 0) {
        parts.push(`${described.missing} member${described.missing === 1 ? '' : 's'} not registered right now, skipped.`)
      }
      return {
        ok: true,
        message: parts.join(' '),
        groups: [{
          id: group.id,
          name: group.name,
          prompt: group.prompt ?? '',
          memberCount: group.members.length,
          unlocked: wasOpen || nowOpen
        }]
      }
    }
  }
}

/**
 * Keep the `get_tools` registration in step with the group definitions.
 *
 * Registered on the FIRST deferred group and unregistered when the LAST one goes away,
 * because the tool is the feature's only mouth: a profile that never defers a group pays
 * no schema for it, and a profile that stops deferring drops it again without a restart.
 * Registration is global (one registry entry, every session), while the unlock it
 * performs is per session — that split is what keeps the tool list stable across
 * conversations while the DISCLOSURE state still differs.
 *
 * A registration failure is swallowed to "no tool this time": the index section is
 * registered separately, so the model would still learn the groups exist, and the next
 * group edit retries.
 * @param ctx - the plugin context (`tools`).
 * @param host - `{ tools }`, read per call for the model-facing registry view.
 */
function createDeferredTools(ctx, host) {
  /** The registration disposer while `get_tools` is mounted. */
  let off
  let live = true
  const sync = () => {
    if (!live) return
    if (deferredGroups().length === 0) {
      if (off !== undefined) {
        try {
          off()
        } catch {
          // The fiber is already gone; nothing left to dispose.
        }
        off = undefined
      }
      return
    }
    if (off !== undefined) return
    try {
      off = ctx.tools.register(
        getToolsDefinition({
          enable(sessionId, groupId) {
            // Unlocking is not the whole job: the registry mask has to come off in the
            // same breath, which `unlockGroup` does through the unlock hook. Returning
            // its boolean is all this call has to add.
            return unlockGroup(sessionId, groupId)
          },
          names(agent) {
            // The registry projection is the model's tool list. The assemble waterfall
            // is a catalog by comparison; reading it here would report a member the
            // filter happens to drop (a scope-local name) as "missing" although the
            // model still receives it.
            return new Set(registryToolNames(host, agent))
          },
          registry: { tools: ctx.tools }
        })
      )
    } catch {
      off = undefined
    }
  }
  return {
    sync,
    dispose() {
      live = false
      if (off !== undefined) {
        try {
          off()
        } catch {
          // Already gone.
        }
        off = undefined
      }
    }
  }
}

/**
 * Register the deferred-group index as a system-prompt section.
 *
 * `text` is a FUNCTION, not a string: it is re-evaluated for every assembly with that
 * assembly's context, and the harness puts the calling agent on it. That is what lets
 * ONE global registration report a different locked set per session — no per-agent
 * shadow sections, no re-registration when a group is loaded.
 */
function registerDeferredIndex(scope) {
  // Read through `get`, NEVER through a property: Cordis throws
  // `cannot get property "systemPrompt" without inject` on a property access to a
  // service this context did not declare, and that throw takes the WHOLE mount down.
  const systemPrompt = scope?.get?.('systemPrompt')
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return
  try {
    scope.effect(
      () =>
        systemPrompt.section({
          name: INDEX_SECTION,
          order: INDEX_ORDER,
          // The index is assembled from user text; a stray `{{name}}` in a group's
          // description prompt must stay literal instead of failing the assembly.
          interpolate: false,
          text: (context) => deferredIndexText(sessionIdOf(context))
        }),
      'tools-panel: deferred tool index'
    )
  } catch {
    // Degrade, never die: without the index the model does not learn the groups exist,
    // but the kill switch, the routes and `get_tools` all still work.
  }
}

// --- skills (protocol 8) ------------------------------------------------------

/** The live agent for one session, or undefined when the session is not running. */
function agentFor(host, sessionId) {
  try {
    const live = host?.agents?.get?.(sessionId)
    if (live !== undefined) return live
  } catch {
    /* the registry is between generations; the event-seen map below still answers */
  }
  // The `agents` service is provided asynchronously at boot, so it can still be missing
  // while this plugin is already mounted; `agent/created` hands us the agent object in
  // that window. Without the fallback the skills/prompts tabs report "no live agent"
  // for a conversation that is plainly running.
  return host?.seenAgents?.get?.(sessionId)
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

/** The `run_code` transport schema a PTC step collapses the whole catalog into. */
const RUN_CODE_NAME = 'run_code'

/**
 * The registry's view of one agent's tools.
 *
 * This is what `schemas(agent)` answers: the scope's inherited and own contributions
 * after restrictions. It is NOT what the model receives — an assemble-time listener
 * runs later and may still drop names — so it is only the fallback for the catalog
 * read below.
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
 * The names in the assembled CATALOG, or `undefined` when the assembly cannot answer.
 *
 * `assembly.tools` is the post-waterfall catalog: what the panel and any other
 * prompt-side consumer read as "the tools this conversation offers". It is NOT the
 * request's declaration list — that is `schemas(agent)`, the registry projection — but
 * it is the closest thing to a preset-scoped catalog this plugin can read, and every
 * assemble-time filter (this plugin's and other plugins') lands in it.
 *
 * The two views agree on everything this panel hides: the registry mask removes global
 * names, this filter removes them from the catalog, and the scope-local names the mask
 * cannot reach are unioned back into the menu as policy rows (`deferred` / `denied`).
 *
 * PTC presentation collapses the catalog to the single `run_code` transport schema.
 * In that mode the per-tool list is still the registry's, so answering `run_code` alone
 * would hide every switch the tab exists for.
 */
async function assembledToolNames(host, agent, signal) {
  let assembly
  try {
    assembly = await assembleFor(host, agent, signal)
  } catch {
    return undefined
  }
  const tools = assembly?.tools
  if (!Array.isArray(tools)) return undefined
  const names = []
  for (const schema of tools) {
    if (typeof schema?.name === 'string' && schema.name.length > 0) names.push(schema.name)
  }
  if (names.length === 1 && names[0] === RUN_CODE_NAME) return undefined
  return names
}

/**
 * Tool names the session can see, plus every name it has denied.
 *
 * THE LIST IS THE ASSEMBLED CATALOG, with `schemas(agent)` as the fallback — no
 * `systemPrompt` service, an assembly that fails or does not carry `tools`, or the PTC
 * collapse above. The assembly is read because that is the list other prompt-side
 * filters shape, and under a preset that empties its catalog ("空白模式") the registry
 * still holds its inherited rows; offering live-looking switches for tools the model
 * would not receive was the bug this read replaced.
 *
 * The denied names are unioned in because hiding is exactly what removes them from
 * that answer — without the union the control could only ever switch tools OFF. A
 * denied name that is not in the catalog (or in the registry) is still listed: the
 * user has to be able to turn it back on.
 *
 * NO FALLBACK TO THE GLOBAL VIEW. An empty answer is the truthful answer for a
 * session that can call nothing; the menu shows "no tools" instead of inventing rows
 * for every process-wide tool.
 * @param sessionId - the conversation's session.
 * @param host - `{ tools, agents, systemPrompt }`.
 * @param signal - bounds the assembly read; the registry fallback needs none.
 * @returns the sorted union of the session's visible tools and its denied names.
 */
async function toolsForSession(sessionId, host, signal) {
  const agent = agentFor(host, sessionId)
  const assembled = agent === undefined ? undefined : await assembledToolNames(host, agent, signal)
  const visible = assembled ?? (agent === undefined ? [] : registryToolNames(host, agent))
  // The DEFERRED names are unioned in for the same reason the denied ones are: hiding
  // is what removes them from the assembly, and the panel must keep their rows (a
  // deferred tool still has its own switch, and the group editor still needs them).
  const deferred = deferredNamesFor(sessionId)
  return [...new Set([...visible, ...denySetFor(), ...deferred])].sort()
}

/**
 * How many of the hidden names the registry no longer offers to this session.
 *
 * This is the difference between "hidden" and "merely guarded". A name that is denied
 * (or deferred) but still in `schemas(agent)` was NOT masked — it is being stopped by
 * the guard alone, which is exactly the symptom this number exists to expose. Reading it
 * from the snapshot is what makes that answerable without a debugger.
 */
function maskedCount(sessionId, host) {
  const hidden = hiddenNamesFor(sessionId)
  if (hidden.size === 0) return 0
  const agent = agentFor(host, sessionId)
  if (agent === undefined) return 0
  try {
    const visible = new Set(host.tools.schemas(agent).map((schema) => schema.name))
    let masked = 0
    for (const name of hidden) if (!visible.has(name)) masked += 1
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
 *
 * Async because that list is the assembled, model-facing catalog (one waterfall
 * read per state request). `signal` bounds the read; a failure falls back to the
 * registry view inside `toolsForSession` rather than failing the request.
 */
async function snapshot(sessionId, host, signal) {
  const tools = host === undefined ? [...denied].sort() : await toolsForSession(sessionId, host, signal)
  return {
    protocol: PROTOCOL,
    sessionId,
    tools,
    denied: [...denied].sort(),
    // Diagnostics, not UI: how many hidden names are really gone from the registry's
    // view of this session (0 means the switch is being enforced by the guard alone),
    // which scopes the restriction is mounted on, which names the scope refused to
    // mask, and why the last mount failed.
    masked: host === undefined ? undefined : maskedCount(sessionId, host),
    scopes: host?.restrictor?.size ?? 0,
    unmaskable: host?.restrictor?.unmaskableFor(sessionId) ?? [],
    ...(host?.restrictor?.error === undefined ? {} : { scopesError: host.restrictor.error }),
    // The user's groups, copied so a caller cannot mutate the live definitions. The
    // disclosure fields travel with them: the control draws the badge from `disclosure`
    // and seeds the dialog from `prompt`.
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      members: [...group.members],
      disclosure: group.disclosure === true,
      prompt: group.prompt ?? ''
    })),
    // Progressive disclosure, THIS session: the names currently withheld by it, and the
    // group ids already loaded. Both are session-scoped: two tabs on two conversations
    // legitimately report different sets.
    deferred: [...deferredNamesFor(sessionId)].sort(),
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
function setDeny(names) {
  denied = new Set(names)
  saveTools()
  // The registry has to be told: unlike the assembly filter, a restriction is an
  // explicit registration, so a changed set must be re-applied to every mounted scope.
  onDenyChanged()
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
    // The list in the answer comes from one assembly, so bound it: a hanging
    // assemble must not leave the control on its loading line forever.
    const { signal, done } = requestSignal()
    try {
      sendJson(res, 200, { ok: true, state: await snapshot(sessionId, host, signal) })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
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
  const hasHide = Object.prototype.hasOwnProperty.call(payload, 'hide')
  if (!hasDeny && !hasGroups && !hasHide) {
    sendJson(res, 409, {
      ok: false,
      error:
        `this host speaks tools-panel protocol ${PROTOCOL} and recognizes none of ` +
        `\`deny\`, \`groups\`, \`hide\`; it is probably running older code than the page — restart DSH`
    })
    return
  }
  if (hasHide) {
    // The manual counterpart of `get_tools`: lock the listed groups again for THIS
    // session. The group definition (and its disclosure flag) is untouched, so the
    // model can fetch it again later.
    const ids = cleanDeny(payload.hide)
    if (ids === undefined) {
      sendJson(res, 400, { ok: false, error: '`hide` must be an array of group ids' })
      return
    }
    for (const id of ids) lockGroup(sessionId, id)
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
  // The answer reports the state AFTER the write, which means re-reading the
  // model-facing catalog; bound that read exactly like the GET above.
  const { signal, done } = requestSignal()
  try {
    sendJson(res, 200, { ok: true, state: await snapshot(sessionId, host, signal) })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
  } finally {
    done()
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
  /**
   * The `agents` service, resolved per call instead of captured.
   *
   * Profile bundles load concurrently: when this row is applied the agent loop is often
   * still starting, and `ctx.get('agents')` answers `undefined` for a service that is
   * perfectly available a moment later. Capturing that `undefined` is what silently
   * disabled the skill shadows and made the skills/prompts tabs answer "no live agent"
   * for a live conversation.
   */
  const agentsNow = () => ctx.get('agents')

  /**
   * Agents seen through lifecycle events.
   *
   * The payload carries the agent, so the per-agent half works even while the service is
   * unavailable; the tabs fall back to this map in that window.
   */
  const seenAgents = new Map()

  // The skills tab's other half: a same-name runtime registration with both invocation
  // flags off, mounted inside each live agent's scope. It is what makes the runtime
  // skills (plugin-injected, bundled) switchable at all — they have no SKILL.md to edit.
  const skillShadows = createSkillShadows(ctx, agentsNow)
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

  // The REGISTRY half of hiding: `restrict()` is the seam that decides the model's tool
  // declarations (`request/header.tools` is this projection; the assemble waterfall is
  // presentation). Mounted per agent because the contract is scope-bound. Both policy
  // edits that change the wanted set — a deny write and a group load/lock — re-apply.
  const restrictor = createRestrictor()
  ctx.effect(() => () => restrictor.dispose(), 'tools-panel: restriction scopes')
  onDenyChanged = () => restrictor.syncAll()
  onUnlockChanged = () => restrictor.syncAll()
  ctx.effect(
    () => () => {
      onDenyChanged = () => {}
      onUnlockChanged = () => {}
    },
    'tools-panel: policy change hooks'
  )

  // Progressive disclosure: the fetch tool, mounted only while some group defers. The
  // unlock it performs is session state PLUS a registry edit: `unlockGroup` fires the
  // hook above, so the group's mask is lifted before the call returns.
  const deferred = createDeferredTools(ctx, { tools: ctx.tools })
  ctx.effect(() => () => deferred.dispose(), 'tools-panel: get_tools')
  deferred.sync()

  // A group edit changes which halves exist: whether `get_tools` is registered at all.
  // `replaceGroups` is the single write path (route and agent tool alike), so one hook
  // is enough.
  onGroupsChanged = () => {
    deferred.sync()
    restrictor.syncAll()
  }
  ctx.effect(
    () => () => {
      onGroupsChanged = () => {}
    },
    'tools-panel: group change hook'
  )

  // The deferred-group index. Registered through the same optional-service probe as the
  // tabs: without `systemPrompt` the model does not learn the groups exist, but
  // `get_tools` and the switch still work.
  if (ctx.get('systemPrompt') !== undefined) registerDeferredIndex(ctx)
  else ctx.inject(['systemPrompt'], (scope) => registerDeferredIndex(scope))

  /** Wire one agent into the per-agent half. */
  const attachAgent = (agent) => {
    if (agent === undefined || typeof agent.id !== 'string') return
    seenAgents.set(agent.id, agent)
    const parentId = detectParent(agentsNow(), agent)
    if (parentId !== undefined) parents.set(agent.id, parentId)
    skillShadows.mount(agent)
    // Mount the restriction at creation, so a switch set BEFORE this agent existed
    // already covers it.
    restrictor.mount(agent)
    restrictor.syncAll()
  }

  // The lifecycle listeners are registered UNCONDITIONALLY and read the agent out of the
  // payload: gating them on `ctx.get('agents')` is what left them dead while the service
  // was still loading.
  ctx.effect(
    () => ctx.on('agent/created', ({ agent }) => attachAgent(agent)),
    'tools-panel: agent mounts'
  )
  ctx.effect(
    () => ctx.on('agent/disposed', ({ agent }) => {
      if (agent === undefined || typeof agent.id !== 'string') return
      // The LINK goes, the group definitions and unlocks stay: a session that closes and
      // resumes later keeps what it loaded.
      parents.delete(agent.id)
      seenAgents.delete(agent.id)
      skillShadows.release(agent.id)
      // The restriction itself was owned by the agent's scope and is already gone.
      restrictor.release(agent.id)
    }),
    'tools-panel: agent cleanup'
  )

  /**
   * Attach to the agents that already exist, then re-apply the skill shadows. Called
   * once at mount (a reload can find sessions already open) and once more when the
   * `agents` service turns up, which is the ordinary case at boot. Everything inside is
   * idempotent, so running twice costs nothing.
   */
  const attachLive = () => {
    let list
    try {
      list = agentsNow()?.list?.() ?? []
    } catch {
      return
    }
    for (const agent of list) attachAgent(agent)
    // A skill switched off before this process had any agent must apply now, and so must
    // a denied or deferred name.
    skillShadows.syncAll()
    restrictor.syncAll()
  }
  attachLive()
  if (agentsNow() === undefined) {
    ctx.effect(
      () => ctx.inject(['agents'], () => attachLive()),
      'tools-panel: late agent registry'
    )
  }

  const deps = {
    tools: ctx.tools,
    // Probed per request, never captured: the registry may only be provided after this
    // plugin mounts (see `agentsNow`).
    get agents() { return agentsNow() },
    /** Agents seen through lifecycle events: the tabs' fallback while it is missing. */
    seenAgents,
    restrictor,
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
  GET_TOOLS,
  HEADER,
  INDEX_ORDER,
  INDEX_SECTION,
  MAX_GROUP_NAME,
  MAX_GROUP_PROMPT,
  MAX_GROUPS,
  MAX_INDEX_PROMPT,
  MAX_NAME,
  MAX_PROMPTS,
  MAX_SECTION_TEXT,
  MAX_SKILL_DESCRIPTION,
  MAX_TOOLS,
  PROMPTS_ROUTE,
  PROTOCOL,
  createDeferredTools,
  createRestrictor,
  hiddenNamesFor,
  createPromptFilter,
  createSchemaFilter,
  deferredGroups,
  deferredIndexText,
  deferredNamesFor,
  findGroupByName,
  getToolsDefinition,
  lockedGroupsFor,
  lockGroup,
  normalizeGroupPrompt,
  parents,
  registerDeferredIndex,
  sessionIdOf,
  unlockGroup,
  unlocked,
  unlockedFor,
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
  onGroupsChanged()
  return groups
}

/** Test-only: replace the live group definitions without touching disk. */
export function setGroups(next) {
  groups = next
}
