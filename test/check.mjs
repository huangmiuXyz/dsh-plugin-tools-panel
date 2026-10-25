// Offline self-check for the merged tool panel: the tool guard (host + client) and\.
// the plugin switch (client only) in one package.
//
// The fakes here mirror the REAL contracts, not invented shapes:
//
//   - `ctx.tools.guard(fn)`: `ToolGuard = (execution: Readonly<ToolExecution>) =>
//     string | undefined`, and "synchronous check; a returned string denies the
//     execution" (the `tools` Service contract). The returned value is the exact
//     disposer that unregisters the guard.
//   - `ctx.tools.restrict({ deny })`: "Restrict global tools for the calling agent
//     scope. Empty filters, unknown names, scope-local names, and reserved transport
//     names fail." The fake throws on an unknown name so the plugin's name filtering
//     is exercised rather than assumed.
//   - `ctx.tools.schemas(scope?)`: "Project visible definitions onto the model-facing
//     schema fields" — the fake returns whatever is not currently restricted.
//   - `agent.ctx.plugin(def)`: mounting a fiber into one agent's scope. The real
//     registry runs `apply` with a context scoped to that agent; the fake does the
//     same, and `dispose()` on the returned fiber tears the scope down.
//   - `ctx.on(name, listener)`: the payload for `agent/created` is
//     `{ agent, source, signal }` (the Event contract).
//   - `ctx.agents.isOwnedBy(id, owner)`: "Test whether a live agent was created
//     through one exact parent agent's scoped context."
//   - `ctx.effect(fn, label)` / `ctx.inject(names, cb)`: Cordis registration.
//   - `webServer.register({ kind: 'exact', path, handler })`: the shipped route
//     shape, read off `dsh-edit-retry`'s host half.
//   - The control route is exercised over a REAL node:http server rather than a
//     mock req/res, so a wrong header check or a body read that never ends shows up
//     here instead of in the browser.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Isolate the durable bit of this plugin BEFORE importing it: group definitions are
// written under `$DSH_HOME/tool-guard/groups.json`, and a test run must never touch
// the developer's real profile. `groupsFile()` reads the variable per call, but the
// module also loads the file once at import time — hence "before".
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-tools-panel-check-'))
process.env.DSH_HOME = SANDBOX

/** Repo root, resolved from this file so the check runs from any checkout. */
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  — ' + detail}`)
  if (!ok) failures++
}

// --- 1. manifests -------------------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'))
check('package.json: name', pkg.name === 'dsh-plugin-tools-panel', pkg.name)
check('package.json: type module', pkg.type === 'module', pkg.type)
check('package.json: dsh.client.platform', pkg.dsh?.client?.platform === 'web')
// `immediately` puts the bundle in the boot-blocking tier: a module failure then
// fails the WHOLE web boot ("web boot: N entry did not activate") instead of
// degrading to one inactive plugin. Never set it without a reason.
check(
  'package.json: not in the boot-blocking tier',
  pkg.dsh?.client?.immediately === undefined,
  String(pkg.dsh?.client?.immediately)
)
check('package.json: exports ./client', typeof pkg.exports?.['./client'] === 'string', pkg.exports?.['./client'])
check('package.json: exports .', typeof pkg.exports?.['.'] === 'string', pkg.exports?.['.'])
check('package.json: bundle patch', typeof pkg.dsh?.bundle?.patch === 'string', pkg.dsh?.bundle?.patch)
// This package ships no Config schema on purpose: it must import nothing at all,
// because a profile installs it with `link:` and there is no dependency to resolve.
check('package.json: no runtime dependencies', pkg.dependencies === undefined, JSON.stringify(pkg.dependencies))

const patch = fs.readFileSync(path.join(PKG, pkg.dsh.bundle.patch), 'utf8')
check('cordis.patch.yml: inserts the package', patch.includes("name: 'dsh-plugin-tools-panel'"), patch.trim().split('\n').pop())
check('cordis.patch.yml: insert block', /^\s*-\s*insert:/m.test(patch))

// The host half must import no PACKAGE (a `link:`-installed plugin has nothing to
// resolve a bare specifier against); Node built-ins are fine — that is how the
// group definitions reach disk. The client half may import react and react-dom only.
const hostSource = fs.readFileSync(path.join(PKG, 'src', 'index.js'), 'utf8')
const clientSource = fs.readFileSync(path.join(PKG, 'src', 'client.js'), 'utf8')
const hostImports = [...hostSource.matchAll(/^\s*import\s[^\n]*?from\s+'([^']+)'/gm)].map((m) => m[1])
const hostPackages = hostImports.filter((name) => !name.startsWith('node:'))
check('host half: imports no package', hostPackages.length === 0, hostPackages.join(', ') || hostImports.join(', '))
const clientImports = [...clientSource.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1])
check(
  'client half: only react require() calls',
  clientImports.every((name) => name === 'react' || name === 'react-dom'),
  clientImports.join(', ')
)
check('client half: registers an id', clientSource.includes("id: 'dsh-plugin-tools-panel'"), 'window.__ModuleLoader__.load')

// --- 2. per-tool policy -------------------------------------------------------
const {
  EMPTY_DENY,
  HEADER,
  PROTOCOL,
  ROUTE,
  cleanDeny,
  denySetFor,
  makeGuard,
  ownerOf,
  parents,
  policies,
  policyFor,
  MAX_GROUPS,
  MAX_PROMPTS,
  MAX_SECTION_TEXT,
  PROMPTS_ROUTE,
  SKILLS_ROUTE,
  getPromptDisabled,
  groupsFile,
  loadGroups,
  loadPrompts,
  normalizeGroups,
  normalizePromptNames,
  patchSkillFrontmatter,
  promptsFile,
  promptsState,
  replacePromptDisabled,
  saveGroups,
  savePrompts,
  setDeny,
  setGroups,
  getGroups,
  skillsState,
  togglePromptSection,
  snapshot
} = await import(pathToFileURL(path.join(PKG, 'src', 'index.js')).href)

// The two halves are loaded independently (the bundle hot-reloads; the host half
// does not), so their protocol numbers are the ONLY thing keeping a saved edit from
// silently pairing a new client with a stale host. They must be edited together.
const clientProtocol = Number(clientSource.match(/^\s*const PROTOCOL = (\d+)/m)?.[1])
check('protocol: the client half declares it', Number.isInteger(clientProtocol), String(clientProtocol))
check('protocol: both halves agree', clientProtocol === PROTOCOL, `client ${clientProtocol} vs host ${PROTOCOL}`)
check(
  'protocol: the client writes the field the host reads',
  clientSource.includes('JSON.stringify({ sessionId, deny })'),
  'deny, not per-kind booleans'
)

// THE point of this revision: nothing is classified. A name is denied by being in
// the list, and no table in this package decides what a tool "is".
check(
  'classify: no built-in tool classification remains',
  !/READ_TOOLS|WRITE_TOOLS|SHELL_TOOLS|AGENT_TOOLS|KINDS|SWITCH_FOR/.test(hostSource),
  'the group tables and kinds are gone'
)
check(
  'classify: no tool name is hard-coded in the host half',
  !/\b(?:read|write|edit|bash|pwsh|grep|glob|subagent|workflow)\b\s*[,)]\s*$/.test(
    hostSource.replace(/^\s*\*.*$/gm, '')
  ),
  'the list comes from the registry, not from this file'
)

{
  // A policy record as the host stores it.
  const record = (deny = [], extra = {}) => ({
    deny: new Set(deny),
    blocked: 0,
    last: undefined,
    ...extra
  })
  const call = (name, sessionId) => ({
    name,
    callId: 'call-1',
    arguments: {},
    signal: new AbortController().signal,
    ...(sessionId === undefined ? {} : { agent: { id: sessionId } })
  })
  const freshPolicies = (entries = {}) =>
    new Map(Object.entries(entries).map(([id, patch]) => [id, record(patch)]))
  const freshTree = (entries = {}) => new Map(Object.entries(entries))

  const table = freshPolicies()
  const guard = makeGuard(table, freshTree())
  check('guard: allows everything while nothing is denied', guard(call('write', 's1')) === undefined)
  table.set('s1', record(['write']))
  const reason = guard(call('write', 's1'))
  check('guard: denies a denied tool', typeof reason === 'string', String(reason))
  check('guard: denial names the tool', reason.includes('"write"'), reason)
  check('guard: denial uses the requested wording', reason.includes('此操作已被用户实时禁用'), reason)
  check('guard: denial tells the model not to retry', reason.includes('Do not retry'), reason)
  check('guard: counts the denial', table.get('s1').blocked === 1, String(table.get('s1').blocked))
  check('guard: records the last denial with its session', table.get('s1').last?.tool === 'write')
  // PER-TOOL is the whole point: one name denied says nothing about any other name,
  // including names that used to live in the same group as it.
  check('guard: denying one write tool leaves another allowed', guard(call('edit', 's1')) === undefined)
  check('guard: and leaves bash allowed', guard(call('bash', 's1')) === undefined)
  table.set('s1', record(['bash']))
  check('guard: the denied name is the only one refused', guard(call('write', 's1')) === undefined)
  check('guard: and it is still refused', typeof guard(call('bash', 's1')) === 'string')
  // Any name at all can be denied — the registry decides what exists, not this list.
  table.set('s1', record(['mcp__github__create_issue']))
  check('guard: an MCP tool is deniable by name', typeof guard(call('mcp__github__create_issue', 's1')) === 'string')
  table.delete('s1')
  check('guard: allows again as soon as the list is empty', guard(call('bash', 's1')) === undefined)

  // Scoping: restricting one session must not touch another.
  const scoped = freshPolicies()
  const scopedGuard = makeGuard(scoped, freshTree())
  scoped.set('s1', record(['write']))
  check('scope: the restricted session is denied', typeof scopedGuard(call('write', 's1')) === 'string')
  check('scope: an unrelated session is untouched', scopedGuard(call('write', 's2')) === undefined)
  scoped.set('s2', record(['read']))
  check(
    'scope: each session keeps its own list',
    scopedGuard(call('read', 's1')) === undefined && typeof scopedGuard(call('read', 's2')) === 'string'
  )

  // Inheritance: a restriction reaches what the session spawned, however deep, and
  // whether or not the child existed when the list was written.
  const tree = freshTree({ child: 'root', grand: 'child' })
  const inherited = freshPolicies()
  const inheritGuard = makeGuard(inherited, tree)
  check('inherit: an unrestricted tree allows everything', inheritGuard(call('write', 'grand')) === undefined)
  inherited.set('root', record(['write']))
  check('inherit: the root is denied', typeof inheritGuard(call('write', 'root')) === 'string')
  check('inherit: the child inherits', typeof inheritGuard(call('write', 'child')) === 'string')
  check('inherit: the grandchild inherits', typeof inheritGuard(call('write', 'grand')) === 'string')
  check('inherit: the inherited denial leaves other names alone', inheritGuard(call('edit', 'grand')) === undefined)
  inherited.delete('root')
  check('inherit: releasing the root releases the grandchild', inheritGuard(call('write', 'grand')) === undefined)

  // A child may hold its own list; the NEAREST one wins.
  const nearest = freshPolicies()
  const nearestGuard = makeGuard(nearest, freshTree({ child: 'root' }))
  nearest.set('root', record(['read']))
  check('inherit: the child sees the parent list', typeof nearestGuard(call('read', 'child')) === 'string')
  nearest.set('child', record(['bash']))
  check("inherit: the child's own list wins over the parent's", nearestGuard(call('read', 'child')) === undefined)
  check("inherit: and the child's own restriction applies", typeof nearestGuard(call('bash', 'child')) === 'string')
  check('inherit: the parent keeps its own list', typeof nearestGuard(call('read', 'root')) === 'string')

  // Out of scope: no agent, no policy, nothing to deny for.
  const empty = freshPolicies()
  check('scope: an agentless call is not governed', makeGuard(empty, freshTree())(call('write', undefined)) === undefined)

  // A cycle would hang the guard, which runs synchronously inside the pipeline.
  const cyclic = freshPolicies()
  const cycleGuard = makeGuard(cyclic, freshTree({ a: 'b', b: 'a' }))
  check('safety: a parent cycle terminates', cycleGuard(call('write', 'a')) === undefined)
  cyclic.set('a', record(['write']))
  check('safety: a parent cycle still resolves the restriction', typeof cycleGuard(call('write', 'a')) === 'string')
}

// --- 3. request validation ----------------------------------------------------
check('deny: an array is normalized', JSON.stringify(cleanDeny([' b ', 'a', 'a', ''])) === '["b","a"]')
check('deny: a non-array is refused', cleanDeny('write') === undefined)
check('deny: a null is refused', cleanDeny(null) === undefined)
check('deny: non-string entries are dropped', JSON.stringify(cleanDeny([1, 'a', {}])) === '["a"]')
check('deny: an over-long name is dropped', JSON.stringify(cleanDeny(['x'.repeat(300), 'a'])) === '["a"]')
check('deny: an empty array is a valid "allow everything"', JSON.stringify(cleanDeny([])) === '[]')

// --- 3b. user-defined groups ------------------------------------------------
{
  // Normalization: ids are assigned, names trimmed, members deduped and bounded.
  const normalized = normalizeGroups([
    { name: '  git  ', members: ['a', 'a', 'b'] },
    { name: '', members: ['x'] },
    { name: 'no members' },
    null,
    { name: 'named', id: 'fixed-id', members: ['c'] }
  ])
  check('groups: an empty name is dropped', normalized.length === 3, JSON.stringify(normalized.map((g) => g.name)))
  check('groups: a name is trimmed', normalized[0].name === 'git', normalized[0].name)
  check('groups: members are deduped', JSON.stringify(normalized[0].members) === '["a","b"]', JSON.stringify(normalized[0].members))
  check('groups: a group with no members is kept', normalized[1].members.length === 0)
  check('groups: a supplied id is kept', normalized[2].id === 'fixed-id', normalized[2].id)
  check('groups: an id is generated when absent', typeof normalized[0].id === 'string' && normalized[0].id.length > 0)
  check('groups: ids are unique', new Set(normalized.map((g) => g.id)).size === 3)
  check('groups: a non-array is refused', normalizeGroups({}) === undefined)
  check('groups: an absent value is "not sent"', normalizeGroups(undefined) === undefined)
  check('groups: the array is bounded', normalizeGroups(Array.from({ length: MAX_GROUPS + 1 }, () => ({ name: 'x' }))) === undefined)

  // The snapshot carries the groups, and it carries a COPY: a caller that mutates
  // the answer must not corrupt the live definitions the next request reads.
  setGroups([{ id: 'g1', name: 'bundle', members: ['read', 'write'] }])
  const snap = snapshot('nobody')
  check('groups: the snapshot carries them', snap.groups?.[0]?.name === 'bundle', JSON.stringify(snap.groups))
  snap.groups[0].members.push('bash')
  snap.groups[0].name = 'mutated'
  check('groups: the snapshot is a copy', getGroups()[0].name === 'bundle' && getGroups()[0].members.length === 2)
  setGroups([])
  check('groups: clearing works', snapshot('nobody').groups.length === 0)
}

// --- 3b. the model-facing group tool -----------------------------------------
// `manage_tool_groups` is its OWN Loader row, so it must mount and work without the
// guard, the route, or any agent: one `tools.register()` and nothing else.
{
  const registered = []
  const scope = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {
          const at = registered.indexOf(definition)
          if (at >= 0) registered.splice(at, 1)
        }
      }
    },
    effect: (fn) => fn()
  }
  const agentHalf = await import(pathToFileURL(path.join(PKG, 'src', 'agent.js')).href)
  check('agent tool: the half requires only `tools`', JSON.stringify(agentHalf.inject) === '["tools"]', JSON.stringify(agentHalf.inject))
  agentHalf.apply(scope)
  check('agent tool: apply registers exactly one tool', registered.length === 1, String(registered.length))
  const tool = registered[0]
  check('agent tool: the name is manage_tool_groups', tool?.name === 'manage_tool_groups', String(tool?.name))
  // A tool without an output contract is refused by the registry ("must declare
  // output { schema, render }"), so a missing one here would be a broken bundle.
  check('agent tool: declares an output schema and render', typeof tool?.output?.render === 'function' && tool?.output?.schema?.type === 'object')
  check('agent tool: the root schema is an object', tool?.parameters?.type === 'object', String(tool?.parameters?.type))
  check(
    'agent tool: every declared parameter is described',
    Object.values(tool?.parameters?.properties ?? {}).every((node) => typeof node.description === 'string' && node.description.length > 0)
  )
  check(
    'agent tool: only supported JSON-schema keywords',
    !/"(?:anyOf|allOf|pattern|format|minLength|maxItems|\$ref)"/.test(JSON.stringify(tool?.parameters)),
    'the registry rejects the rest'
  )
  check(
    'agent tool: the one parameter is required',
    JSON.stringify(tool?.parameters?.required) === '["action"]',
    JSON.stringify(tool?.parameters?.required)
  )
  check(
    'agent tool: the action enum is the documented set',
    JSON.stringify(tool?.parameters?.properties?.action?.enum) === JSON.stringify(agentHalf.ACTIONS),
    JSON.stringify(tool?.parameters?.properties?.action?.enum)
  )
  // One tool, not six: the whole point of the `action` field.
  check('agent tool: the patch mounts it as a second row', !tool.name.includes('group_'))

  const call = (args) => tool.execute(args)

  // Start from a known empty state: the sandbox home holds no groups file yet.
  setGroups([])
  {
    const answer = await call({ action: 'list' })
    check('agent tool: list on an empty profile says so', answer.groups.length === 0 && answer.message.includes('no tool groups'), answer.message)
    check('agent tool: an empty list still answers ok', answer.ok === true)
  }
  {
    const answer = await call({ action: 'create', name: '  Git  ', members: ['bash', 'edit', 'bash'] })
    check('agent tool: create trims the name', answer.groups[0]?.name === 'Git', answer.groups[0]?.name)
    check('agent tool: create dedupes members', JSON.stringify(answer.groups[0]?.members) === '["bash","edit"]', JSON.stringify(answer.groups[0]?.members))
    check('agent tool: create persists through replaceGroups', getGroups()[0]?.name === 'Git')
    check('agent tool: create reports the count', answer.groups[0]?.memberCount === 2, String(answer.groups[0]?.memberCount))
  }
  {
    const before = await call({ action: 'list' })
    check('agent tool: a second group can be created', before.groups.length === 1)
    let refused
    try {
      await call({ action: 'create', name: 'GIT' })
    } catch (failure) {
      refused = String(failure?.message ?? failure)
    }
    check('agent tool: a duplicate name is refused', typeof refused === 'string' && refused.includes('already exists'), String(refused))
    check('agent tool: and the first group is untouched', getGroups().length === 1)
    await call({ action: 'create', name: '其它', members: ['bash'] })
    check('agent tool: two groups coexist', getGroups().length === 2, String(getGroups().length))
    await call({ action: 'delete', group: '其它' })
  }
  {
    const answer = await call({ action: 'get', group: 'git' })
    check('agent tool: get finds a group by name, case-insensitively', answer.message.includes('"Git"'), answer.message)
    check('agent tool: get reports the members', answer.groups[0]?.members.length === 2)
    const byId = await call({ action: 'get', group: answer.groups[0].id })
    check('agent tool: get finds a group by id', byId.groups[0]?.id === answer.groups[0].id)
  }
  {
    let refused
    try {
      await call({ action: 'get', group: 'nope' })
    } catch (failure) {
      refused = String(failure?.message ?? failure)
    }
    check('agent tool: an unknown group is refused', typeof refused === 'string' && refused.includes('no group matches'), String(refused))
    check('agent tool: the refusal names the known groups', refused.includes('"Git"'), String(refused))
  }
  {
    const added = await call({ action: 'add_members', group: 'Git', members: ['bash', 'grep'] })
    check('agent tool: add_members adds only what is new', JSON.stringify(added.groups[0]?.members) === '["bash","edit","grep"]', JSON.stringify(added.groups[0]?.members))
    const removed = await call({ action: 'remove_members', group: 'Git', members: ['bash'] })
    check('agent tool: remove_members drops a name', JSON.stringify(removed.groups[0]?.members) === '["edit","grep"]', JSON.stringify(removed.groups[0]?.members))
    const set = await call({ action: 'set_members', group: 'Git', members: ['read'] })
    check('agent tool: set_members replaces the list', JSON.stringify(set.groups[0]?.members) === '["read"]', JSON.stringify(set.groups[0]?.members))
    const emptied = await call({ action: 'set_members', group: 'Git' })
    check('agent tool: set_members with no members empties the group', emptied.groups[0]?.members.length === 0)
  }
  {
    let refused
    try {
      await call({ action: 'add_members', group: 'Git', members: [] })
    } catch (failure) {
      refused = String(failure?.message ?? failure)
    }
    check('agent tool: add_members with nothing to add is refused', typeof refused === 'string' && refused.includes('at least one'), String(refused))
  }
  {
    const renamed = await call({ action: 'rename', group: 'Git', name: '版本控制' })
    check('agent tool: rename changes the name', renamed.groups[0]?.name === '版本控制', renamed.groups[0]?.name)
    check('agent tool: rename keeps the id', renamed.groups[0]?.id === getGroups()[0]?.id)
    let refused
    try {
      await call({ action: 'rename', group: '版本控制', name: '   ' })
    } catch (failure) {
      refused = String(failure?.message ?? failure)
    }
    check('agent tool: a blank name is refused', typeof refused === 'string' && refused.includes('must not be empty'), String(refused))
  }
  {
    let refused
    try {
      await call({ action: 'create', name: 'x'.repeat(agentHalf.MAX_GROUP_NAME + 1) })
    } catch (failure) {
      refused = String(failure?.message ?? failure)
    }
    check('agent tool: an over-long name is refused, not clamped', typeof refused === 'string' && refused.includes('at most'), String(refused))
  }
  {
    let refused
    try {
      await call({ action: 'not-an-action' })
    } catch (failure) {
      refused = String(failure?.message ?? failure)
    }
    check('agent tool: an unknown action is refused', typeof refused === 'string' && refused.includes('must be one of'), String(refused))
    let missing
    try {
      await call({})
    } catch (failure) {
      missing = String(failure?.message ?? failure)
    }
    check('agent tool: a missing action is refused', typeof missing === 'string' && missing.includes('must be one of'), String(missing))
  }
  {
    // The render is what the model reads, so both shapes have to be legible.
    const listed = await call({ action: 'list' })
    const text = tool.output.render({ action: 'list' }, listed)[0].text
    check('agent tool: list renders one line per group', text.split('\n').length === 2, text)
    check('agent tool: list renders the members', text.includes('版本控制'), text)
    const edited = await call({ action: 'delete', group: '版本控制' })
    const short = tool.output.render({ action: 'delete' }, edited)[0].text
    check('agent tool: an edit renders the summary only', short.split('\n').length === 1, short)
    check('agent tool: delete removes the group', edited.groups.length === 0 && getGroups().length === 0)
    check('agent tool: delete says the tools stay available', edited.message.includes('still available'), edited.message)
  }
  {
    // A group may name a tool that is not mounted right now: dropping those would
    // quietly destroy the grouping the first time an MCP server failed to connect.
    const answer = await call({ action: 'create', name: 'remote', members: ['mcp__gone__tool'] })
    check('agent tool: an unmounted tool name is kept', JSON.stringify(answer.groups[0]?.members) === '["mcp__gone__tool"]', JSON.stringify(answer.groups[0]?.members))
    setGroups([])
  }
  // The row is a separate entry, so disabling it leaves the panel mounted.
  const patchText = fs.readFileSync(path.join(PKG, pkg.dsh.bundle.patch), 'utf8')
  check(
    'cordis.patch.yml: the tool is its own row',
    /id:\s*'?tools-panel-agent'?/.test(patchText) && /name:\s*'dsh-plugin-tools-panel\/agent'/.test(patchText),
    patchText.trim().split('\n').slice(-1)[0]
  )
  check('package.json: exports ./agent', pkg.exports?.['./agent'] === './src/agent.js', String(pkg.exports?.['./agent']))
}

// --- 4. the live pipeline, over a real HTTP server ----------------------------
/**
 * A Cordis-shaped host: `tools` with restrict/schemas/guard, an agent registry whose
 * agents carry a scope that can mount a fiber, and a REAL http server standing in for
 * `webServer` — so the route, the header check, the body read, the parent detection,
 * and the mounted restriction are exercised end to end.
 */
function fakeHost() {
  const guards = []
  const routes = new Map()
  const listeners = new Map()
  const live = []
  const owners = new Map()
  /** Optional services the panel probes per request (`skills`, `systemPrompt`, …). */
  const extras = {}
  /**
   * Which layer each tool is registered in — the geometry that actually broke this
   * plugin.
   *
   * A PRESET registers its tool rows (`tool-bash`, `tool-fs`, …) into the PRESET's
   * own scope, which every agent using that preset inherits. Only the host
   * composition's rows (`working_directory`, `cordis_inspect_*`, MCP bridges) sit in
   * the global layer. Modelling this split is what makes the old bug visible: a
   * restriction applied on the agent's own scope DOES mask inherited tools, so the
   * failure only shows up when the tool the user switched off lives in a layer the
   * mask was never applied to.
   */
  const PRESET_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'todo_write', 'mcp__github__search']
  const GLOBAL_TOOLS = ['working_directory', 'cordis_inspect_list', 'cordis_inspect_call']
  /** Which names are currently hidden per agent id — what `restrict()` changed. */
  const hidden = new Map()
  /** Which names are hidden per PRESET name — the layer above the agent. */
  /** Agents whose preset mounts no tools: a scope view with nothing in it. */
  const noTools = new Set()
  /** Every restriction call, in order, so the checks can read what was applied. */
  const restrictCalls = []
  /**
   * Every preset ever minted, keyed by preset NAME so agents on the same preset
   * share one layer. `hidden` is the preset's own mask and `ctx` is the scope
   * object the plugin walks up to — both shared, exactly as the real registry
   * shares one mounted preset tree among the agents using it.
   */
  const presets = new Map()
  let nextPresetId = 0
  const server = http.createServer((req, res) => {
    const route = routes.get(new URL(req.url, 'http://localhost').pathname)
    if (route === undefined) {
      res.writeHead(404).end()
      return
    }
    route(req, res)
  })
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    }
  }

  /** The names visible to one agent: both layers, minus what is masked on either. */
  function visibleFor(agentId, preset) {
    if (noTools.has(agentId)) return []
    const shared = presets.get(preset)
    const gone = new Set([...(hidden.get(agentId) ?? []), ...(shared?.hidden ?? [])])
    return [...GLOBAL_TOOLS, ...PRESET_TOOLS].filter((name) => !gone.has(name))
  }

  /** The `tools` service, scoped when it belongs to one agent's context. */
  const tools = {
    guard(fn) {
      guards.push(fn)
      return () => {
        const index = guards.indexOf(fn)
        if (index >= 0) guards.splice(index, 1)
      }
    },
    /**
     * The UNSCOPED view. The real service refuses this ("would mask every agent"),
     * so the fake refuses it too: the plugin registering a process-wide mask would
     * be a bug that only shows up in production otherwise.
     */
    restrict() {
      throw new Error('an unscoped restriction would mask every agent')
    },
    /**
     * The GLOBAL view: the host composition's own rows, nothing hidden.
     *
     * A scope view is what the agent can CALL, so an agent whose preset mounted no
     * tools answers `[]` — the general rule, not a special case: the menu lists what
     * this session can call, whatever the reason it cannot call anything.
     */
    schemas(scope) {
      if (scope === undefined) return GLOBAL_TOOLS.map((name) => ({ name }))
      const agent = live.find((entry) => entry.id === scope.id)
      return visibleFor(scope.id, agent?.preset).map((name) => ({ name }))
    },
    /**
     * Test-only: register a tool later and fire `tools/change`, the way a real
     * registration does. Used to prove a tool that appears AFTER the switch was set
     * is hidden as well. The new row is a PRESET row, because that is the layer that
     * actually gains tools at runtime (an MCP server connecting).
     */
    __register(name) {
      PRESET_TOOLS.push(name)
      for (const listener of listeners.get('tools/change') ?? []) listener()
    }
  }

  /**
   * One agent with a real scoped context: mounting a fiber runs `apply` with a
   * context whose `tools` service belongs to this agent, exactly as the registry
   * hands it to a plugin mounted in `agent.ctx`.
   *
   * The agent ALSO has a parent context standing in for its preset's scope, with a
   * `plugin` of its own — so the plugin's scope-chain walk finds the layer that
   * holds the preset's tools. Without that parent there is nothing to walk and the
   * old single-mount behaviour would look correct.
   *
   * Agents that name the SAME preset share ONE preset scope, which is what the real
   * registry does: the preset's tree is mounted once per generation and every agent
   * using it inherits from that one layer. Sharing it is what makes "the preset layer
   * is masked once, not per agent" a meaningful assertion rather than a tautology.
   */
  function makeAgent(id, preset = 'standard') {
    let shared = presets.get(preset)
    if (shared === undefined) {
      shared = { presetId: `${preset}-${nextPresetId++}`, hidden: new Set() }
      presets.set(preset, shared)
    }
    const presetId = shared.presetId
    const scopedTools = {
      guard: tools.guard,
      /** Restrict the names THIS agent can see — its own layer's mask. */
      restrict(filter) {
        const names = filter?.deny ?? []
        if (names.length === 0) throw new Error('empty restriction')
        for (const name of names) {
          if (!GLOBAL_TOOLS.includes(name) && !PRESET_TOOLS.includes(name)) {
            throw new Error(`unknown global tool: ${name}`)
          }
        }
        restrictCalls.push({ id, names, layer: 'agent' })
        const applied = new Set(hidden.get(id) ?? [])
        for (const name of names) applied.add(name)
        hidden.set(id, applied)
        return () => {
          const set = new Set(hidden.get(id) ?? [])
          for (const name of names) set.delete(name)
          hidden.set(id, set)
        }
      },
      schemas: (scope) => tools.schemas(scope ?? { id })
    }
    /** The same contract one layer up, masking the PRESET's own registrations. */
    const presetTools = {
      guard: tools.guard,
      restrict(filter) {
        const names = filter?.deny ?? []
        if (names.length === 0) throw new Error('empty restriction')
        for (const name of names) {
          if (!PRESET_TOOLS.includes(name)) throw new Error(`unknown global tool: ${name}`)
        }
        restrictCalls.push({ id: presetId, names, layer: 'preset' })
        // The mask belongs to the PRESET, not to this agent: every agent sharing the
        // preset sees the same layer, so a second agent must not get its own copy.
        for (const name of names) shared.hidden.add(name)
        return () => {
          for (const name of names) shared.hidden.delete(name)
        }
      },
      schemas: (scope) => tools.schemas(scope ?? { id })
    }
    const agent = { id, preset }
    agent.presetId = presetId
    agent.ctx = {
      // `fiber.uid` is the scope's identity and `fiber.parent` is the enclosing
      // CONTEXT — the documented Cordis shape, which is what the plugin walks.
      fiber: { uid: id, parent: undefined },
      plugin(definition) {
        const fiberCtx = {
          tools: scopedTools,
          // Resolved per CALL: the prompt-shadow plugin is mounted when this agent
          // appears, while the fake `systemPrompt` service is installed later by the
          // prompt-section test. A promise-of-a-service would make the mount order
          // decide whether the test works, which is exactly what a real registry does
          // not do.
          systemPrompt: {
            section(def) {
              const service = extras.systemPrompt
              if (service === undefined) throw new Error('no systemPrompt service')
              return service.__scoped(id)(def)
            }
          },
          effect: (fn) => fn(),
          get: () => undefined,
          on: () => () => {}
        }
        definition.apply?.(fiberCtx)
        return {
          dispose() {
            hidden.delete(id)
          }
        }
      }
    }
    // The preset scope above it. `fiber.parent` is the link the plugin's walk follows.
    // Shared per preset: a second agent on the same preset points at the SAME object,
    // so the plugin's "already mounted" check has a real second agent to dedupe.
    const presetCtx = shared.ctx ?? {
      fiber: { uid: presetId, parent: undefined },
      plugin(definition) {
        const fiberCtx = {
          tools: presetTools,
          effect: (fn) => fn(),
          get: () => undefined,
          on: () => () => {}
        }
        definition.apply?.(fiberCtx)
        return { dispose() {} }
      }
    }
    shared.ctx = presetCtx
    agent.ctx.fiber.parent = presetCtx
    return agent
  }

  const agents = {
    list: () => [...live],
    get: (id) => live.find((agent) => agent.id === id),
    isOwnedBy: (id, owner) => owners.get(id) === owner.id,
    /** Test-only: an agent whose preset mounts no tools (any reason). */
    withoutTools(id) {
      noTools.add(id)
    },
    /** Test-only: the preset scope id above one agent, as the plugin walks it. */
    presetScopeOf(id) {
      return presets.get(live.find((agent) => agent.id === id)?.preset)?.presetId
    },
    /** Test-only: create an agent, optionally owned by an existing one. */
    spawn(id, parentId, preset = 'standard') {
      const agent = makeAgent(id, preset)
      live.push(agent)
      if (parentId !== undefined) owners.set(id, parentId)
      const payload = { agent, source: 'startup' }
      for (const listener of listeners.get('agent/created') ?? []) listener(payload)
      return agent
    },
    dispose(id) {
      const index = live.findIndex((agent) => agent.id === id)
      if (index >= 0) live.splice(index, 1)
      for (const listener of listeners.get('agent/disposed') ?? []) listener({ agent: { id } })
    }
  }
  const ctx = {
    tools,
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {
        const at = list.indexOf(listener)
        if (at >= 0) list.splice(at, 1)
      }
    },
    get: (name) => (name === 'webServer' ? webServer : name === 'agents' ? agents : extras[name]),
    inject: (names, callback) => callback({ webServer, agents, effect: (fn) => fn() }),
    effect: (fn) => fn()
  }
  return { agents, ctx, extras, guards, hidden, live, routes, restrictCalls, server, tools }
}

// The module-level tables are shared with `apply`, so clear them before wiring the
// fake host; the assertions below read them directly.
policies.clear()
parents.clear()

const host = fakeHost()
const { apply } = await import(pathToFileURL(path.join(PKG, 'src', 'index.js')).href)
apply(host.ctx)
/** Let the deferred `tools/change` re-apply run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))
check('apply: registers exactly one guard', host.guards.length === 1, String(host.guards.length))
check('apply: registers the control route', host.routes.has(ROUTE), ROUTE)

await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${host.server.address().port}`
const get = (sessionId) =>
  fetch(sessionId === undefined ? `${base}${ROUTE}` : `${base}${ROUTE}?sessionId=${encodeURIComponent(sessionId)}`)
const post = (body, withHeader = true) =>
  fetch(`${base}${ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(withHeader ? { [HEADER]: '1' } : {}) },
    body: JSON.stringify(body)
  })

try {
  // Two independent sessions, plus a delegated child and grandchild under the first.
  // The sibling gets a DIFFERENT preset on purpose: two agents on one preset share
  // that preset's layer, so masking it would reach the sibling — which is correct
  // registry behaviour but would make "another session is untouched" untestable.
  host.agents.spawn('root-a')
  host.agents.spawn('root-b', undefined, 'other')
  host.agents.spawn('child-a', 'root-a')
  host.agents.spawn('grand-a', 'child-a')
  check('tree: the child link was recorded', parents.get('child-a') === 'root-a', String(parents.get('child-a')))
  check('tree: the grandchild link was recorded', parents.get('grand-a') === 'child-a', String(parents.get('grand-a')))
  check('tree: a top-level session has no link', !parents.has('root-a'))

  {
    const answer = await get('root-a')
    const payload = await answer.json()
    check('route: GET answers ok', answer.status === 200 && payload.ok === true, String(answer.status))
    check('route: GET starts with nothing denied', Array.isArray(payload.state?.denied) && payload.state.denied.length === 0)
    check('route: the snapshot advertises its protocol', payload.state?.protocol === PROTOCOL, String(payload.state?.protocol))
    check('route: the snapshot names the session', payload.state?.sessionId === 'root-a')
    check('route: a fresh session is not inherited', payload.state?.inherited === false)
    // THE feature: the list is read from the registry, not hard-coded.
    check(
      'route: the tool list comes from the registry',
      Array.isArray(payload.state?.tools) &&
        payload.state.tools.includes('mcp__github__search') &&
        payload.state.tools.includes('todo_write'),
      (payload.state?.tools ?? []).join(',')
    )
  }
  {
    // THE general rule: the list is what THIS session can call — never the global
    // registry. Three ways a session can have nothing to call, and each must answer
    // an empty list rather than every process-wide tool:
    //   - its preset mounted no tools,
    //   - its agent is not live right now (page open, agent torn down),
    //   - the session id is unknown to the registry.
    // The earlier fallback to `schemas()` failed all three by listing 51 tools.
    host.agents.spawn('no-tools-a')
    host.agents.withoutTools('no-tools-a')
    const mounted = await (await get('no-tools-a')).json()
    check(
      'route: a session whose preset mounts no tools lists none',
      mounted.state?.tools?.length === 0,
      (mounted.state?.tools ?? []).join(',')
    )
    const notLive = await (await get('no-such-session')).json()
    check(
      'route: a session with no live agent lists none',
      notLive.state?.tools?.length === 0,
      (notLive.state?.tools ?? []).join(',')
    )
    // A session that DOES have tools is unaffected: the rule is "this session's
    // tools", not "hide the list".
    const normal = await (await get('root-a')).json()
    check(
      'route: a session with tools still lists them',
      normal.state?.tools?.length > 0 && normal.state.tools.includes('edit'),
      (normal.state?.tools ?? []).join(',')
    )
  }
  {
    const answer = await get()
    check('route: GET without a session is refused', answer.status === 400, String(answer.status))
    check('route: the refusal names the parameter', String((await answer.json()).error).includes('sessionId'))
  }
  {
    // A cross-origin page can POST a "simple" request without a preflight; requiring
    // the custom header is what makes the browser block it.
    const answer = await post({ sessionId: 'root-a', deny: ['write'] }, false)
    check('route: POST without the header is refused', answer.status === 403, String(answer.status))
    check('route: refusal names the missing header', String((await answer.json()).error).includes(HEADER))
  }
  {
    const answer = await post({ deny: ['write'] })
    check('route: POST without a session is refused', answer.status === 400, String(answer.status))
  }
  {
    const answer = await post({ sessionId: 'root-a', deny: ['write'] })
    const payload = await answer.json()
    check('route: POST writes the list', answer.status === 200 && payload.state?.denied?.[0] === 'write')
    check('route: POST answers the state it now holds', payload.state?.denied?.length === 1)
    // Hiding is the primary mechanism: the denied tool must be off this session's
    // visible schema list.
    check(
      'restrict: the denied tool is hidden from the session',
      !(host.tools.schemas({ id: 'root-a' }).map((s) => s.name).includes('write'))
    )
    check(
      'restrict: and the other tools stay visible',
      host.tools.schemas({ id: 'root-a' }).map((s) => s.name).includes('edit')
    )
    // A denied name that hiding removed is still LISTED, or it could never be
    // switched back on.
    check('route: the denied name stays in the list', payload.state?.tools?.includes('write'), (payload.state?.tools ?? []).join(','))
  }
  {
    const guard = host.guards[0]
    const reason = guard({ name: 'write', agent: { id: 'root-a' } })
    check('live: the guard refuses the denied name', typeof reason === 'string', String(reason))
    check('live: the reason is the exact user-facing wording', reason.includes('此操作已被用户实时禁用'), reason)
    check('live: another name is untouched', guard({ name: 'edit', agent: { id: 'root-a' } }) === undefined)
  }
  {
    // THE scoping promise, over the wire: a second session is unaffected.
    const payload = await (await get('root-b')).json()
    check('live: another session is untouched', payload.state?.denied?.length === 0)
    check(
      'live: and its visible tools are whole',
      host.tools.schemas({ id: 'root-b' }).map((s) => s.name).includes('write')
    )
  }
  {
    // Inheritance over the wire: the child and grandchild follow the root, which is
    // what stops "delegate it to a subagent" being a way around the switch.
    const guard = host.guards[0]
    check('live: the child inherits the denial', typeof guard({ name: 'write', agent: { id: 'child-a' } }) === 'string')
    check('live: the grandchild inherits the denial', typeof guard({ name: 'write', agent: { id: 'grand-a' } }) === 'string')
    const payload = await (await get('grand-a')).json()
    check('live: an inheriting session reports its owner', payload.state?.ownerId === 'root-a', String(payload.state?.ownerId))
    check('live: and is flagged as inherited', payload.state?.inherited === true)
    check('live: the inherited list is what it reports', payload.state?.denied?.[0] === 'write')
    // The hide reaches the descendants too: a subagent is not a way around the
    // switch, so its own scope is masked as well.
    check(
      'live: the child cannot even see the denied tool',
      !host.tools.schemas({ id: 'child-a' }).map((s) => s.name).includes('write')
    )
    check(
      'live: nor can the grandchild',
      !host.tools.schemas({ id: 'grand-a' }).map((s) => s.name).includes('write')
    )
  }
  {
    // THE regression this plugin shipped with: the preset's own tool rows live in a
    // layer ABOVE the agent, and a mask applied only on the agent's own scope never
    // reaches them — so the tool stayed in the model's schema list while the panel
    // showed its switch as off. Both layers must be masked, and the proof is the
    // agent's own visibility, not the number of `restrict()` calls.
    //
    // A name that is ALREADY hidden is skipped, so the set is chosen to include one
    // fresh preset tool, one global-layer tool, and one the earlier blocks already
    // masked — which is the interesting case: an unchanged name must not force a
    // re-apply, and a new one must.
    const payload = await (await post({ sessionId: 'root-a', deny: ['bash', 'write', 'working_directory'] })).json()
    check('layers: the denied tools are recorded', payload.state?.denied?.length === 3, JSON.stringify(payload.state?.denied))
    const seen = host.tools.schemas({ id: 'root-a' }).map((s) => s.name)
    check(
      'layers: a tool held by the PRESET layer is hidden from the agent',
      !seen.includes('bash'),
      seen.join(',')
    )
    // A host-composition row (the global layer) must be maskable too, so both
    // layers are exercised by one switch rather than only the deeper one.
    check(
      'layers: a global-layer tool is hidden as well',
      !seen.includes('working_directory'),
      seen.join(',')
    )
    // The mask must actually have been applied on the PRESET layer, not only read
    // as an agent-scope restriction. This is the assertion that fails on the old
    // single-mount code: without it the preset rows simply stay visible.
    const presetCalls = host.restrictCalls.filter((call) => call.layer === 'preset')
    check(
      'layers: the restriction reached the preset layer',
      presetCalls.some((call) => call.names.includes('bash')),
      JSON.stringify(presetCalls.map((call) => call.names))
    )
    // The preset layer is mounted ONCE for the whole preset, however many agents
    // use it — a second agent must not produce a second mask. The count is bounded
    // by the number of preset layers, not by the number of agents.
    const presetLayers = presetCalls.map((call) => call.id)
    check(
      'layers: the preset layer is masked once, not per agent',
      new Set(presetLayers).size <= 1,
      `${new Set(presetLayers).size} layer(s) for ${host.live.length} agent(s)`
    )
    check(
      'layers: the other preset tools stay visible',
      host.tools.schemas({ id: 'root-a' }).map((s) => s.name).includes('read')
    )
    // Releasing must lift BOTH masks, or the tool would stay hidden forever.
    const released = await (await post({ sessionId: 'root-a', deny: [] })).json()
    check('layers: releasing empties the list', released.state?.denied?.length === 0)
    check(
      'layers: and the preset tool is visible again',
      host.tools.schemas({ id: 'root-a' }).map((s) => s.name).includes('bash')
    )
    check(
      'layers: and the global tool is visible again',
      host.tools.schemas({ id: 'root-a' }).map((s) => s.name).includes('working_directory')
    )
  }
  {
    // Editing from the child edits the ROOT: releasing there must release the whole
    // subtree, because that is what the user means by "this session".
    const payload = await (await post({ sessionId: 'grand-a', deny: [] })).json()
    check('live: an edit from a descendant is accepted', payload.state?.denied?.length === 0)
    check('live: releasing from the descendant released the root', host.guards[0]({ name: 'write', agent: { id: 'root-a' } }) === undefined)
    check(
      'live: and the tool is visible again',
      host.tools.schemas({ id: 'root-a' }).map((s) => s.name).includes('write')
    )
  }
  {
    // Per-tool means exactly that: several names, each on its own, and the rest of
    // the registry untouched.
    const payload = await (await post({ sessionId: 'root-a', deny: ['read', 'bash', 'mcp__github__search'] })).json()
    check('route: several names are settable at once', payload.state?.denied?.length === 3, String(payload.state?.denied?.length))
    const guard = host.guards[0]
    for (const name of ['read', 'bash', 'mcp__github__search']) {
      check(`live: ${name} is denied`, typeof guard({ name, agent: { id: 'root-a' } }) === 'string')
    }
    for (const name of ['write', 'edit', 'grep', 'todo_write']) {
      check(`live: ${name} is still allowed`, guard({ name, agent: { id: 'root-a' } }) === undefined)
    }
    // Read stays denied for the session's descendants but never leaks to a sibling.
    check('live: the sibling session may still read', guard({ name: 'read', agent: { id: 'root-b' } }) === undefined)
  }
  {
    // A name that is NOT a global registry tool cannot be masked by `restrict()`
    // (the real one throws "unknown global tool"). It must still be recorded and
    // still denied by the guard — and it must not take the rest of the list down.
    const payload = await (
      await post({ sessionId: 'root-b', deny: ['not-a-real-tool', 'write'] })
    ).json()
    check('route: an unknown name is accepted', payload.state?.denied?.includes('not-a-real-tool'))
    check('restrict: and the known name was still hidden', !host.tools.schemas({ id: 'root-b' }).map((s) => s.name).includes('write'))
    const guard = host.guards[0]
    check('live: the unknown name is denied by the guard', typeof guard({ name: 'not-a-real-tool', agent: { id: 'root-b' } }) === 'string')
    check('live: the known name is denied by the guard too', typeof guard({ name: 'write', agent: { id: 'root-b' } }) === 'string')
    await post({ sessionId: 'root-b', deny: [] })
  }
  {
    // An empty list drops the policy entry entirely, so a session returns to "no
    // policy" rather than carrying an empty record it does not need.
    await post({ sessionId: 'root-a', deny: [] })
    check('route: an empty list drops the policy entry', !policies.has('root-a'))
    check('live: and the descendants are released', host.guards[0]({ name: 'read', agent: { id: 'grand-a' } }) === undefined)
    check(
      'restrict: and the scope is unmasked again',
      host.tools.schemas({ id: 'root-a' }).map((s) => s.name).includes('read')
    )
  }
  {
    // Counters are diagnostics: they prove the guard ran, and they survive the round
    // trip. Re-established here because dropping a policy drops its counters too.
    await post({ sessionId: 'root-a', deny: ['read'] })
    const guard = host.guards[0]
    guard({ name: 'read', agent: { id: 'root-a' } })
    guard({ name: 'read', agent: { id: 'root-a' } })
    const payload = await (await get('root-a')).json()
    check('route: the counter survives the round trip', payload.state?.blocked === 2, String(payload.state?.blocked))
    check('route: the last denial names its tool', payload.state?.last?.tool === 'read')
    await post({ sessionId: 'root-a', deny: [] })
  }
  {
    // The mismatch case: a NEW client's field names against an OLD host. Replayed
    // here by sending only the pre-rename fields, which this revision does not
    // recognize. It must be a loud 409 rather than a silent success — silently
    // answering `ok` with unchanged state is what made a stale host look like a
    // switch that springs back on its own.
    const answer = await post({ sessionId: 'root-a', allowWrite: true })
    const payload = await answer.json()
    check('route: an unrecognized payload is refused', answer.status === 409, String(answer.status))
    check('route: the refusal names the protocol', String(payload.error).includes('protocol'), String(payload.error))
    check('route: the refusal tells the user to restart', String(payload.error).includes('restart'), String(payload.error))
  }
  {
    const answer = await post({ sessionId: 'root-a', deny: 'write' })
    check('route: a non-array deny is a 400', answer.status === 400, String(answer.status))
  }
  {
    const answer = await fetch(`${base}${ROUTE}?sessionId=root-a`, { method: 'DELETE' })
    check('route: an unsupported method is refused', answer.status === 405, String(answer.status))
  }
  {
    // Groups over the wire. They are GLOBAL, so a write from one session is visible
    // to every other, unlike the per-session deny list.
    const answer = await post({
      sessionId: 'root-a',
      groups: [
        { name: 'editors', members: ['write', 'edit'] },
        { name: 'inspect', members: ['read', 'grep'] }
      ]
    })
    const payload = await answer.json()
    check('route: groups are accepted', answer.status === 200 && payload.state?.groups?.length === 2)
    check('route: a group keeps its members', payload.state?.groups?.[0]?.members?.length === 2)
    const other = await (await get('root-b')).json()
    check('route: groups are global, not per session', other.state?.groups?.length === 2)
    // A group is presentation only: it changed no policy by itself.
    check('route: writing groups denies nothing', other.state?.denied?.length === 0)
  }
  {
    // Both fields in one request: the control does this when it saves a group and a
    // switch in the same gesture.
    const payload = await (
      await post({ sessionId: 'root-a', groups: [{ name: 'one', members: ['read'] }], deny: ['bash'] })
    ).json()
    check('route: groups and deny are settable together', payload.state?.groups?.length === 1 && payload.state?.denied?.[0] === 'bash')
    await post({ sessionId: 'root-a', deny: [] })
  }
  {
    const answer = await post({ sessionId: 'root-a', groups: 'nope' })
    check('route: a non-array groups field is a 400', answer.status === 400, String(answer.status))
    const refused = await post({ sessionId: 'root-a', unrelated: true })
    check('route: a body with neither field is a 409', refused.status === 409, String(refused.status))
  }
  {
    // Persistence: the file the Host writes is the file it reads back at load.
    const file = groupsFile()
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    check('groups: the definitions reached disk', Array.isArray(saved.groups) && saved.groups.length === 1, file)
    check('groups: the saved file carries the version', saved.version === 1, String(saved.version))
    check('groups: and the same names the snapshot reported', saved.groups[0].name === 'one')
  }
  {
    // A tool that appears AFTER the list was written (an MCP server connecting) must
    // be hidden too. The fake registers it and emits `tools/change`, which is what a
    // real registration does; the handler defers, so this waits one tick.
    await post({ sessionId: 'root-b', deny: ['mcp__late__tool'] })
    check(
      'tools/change: nothing is hidden before the tool exists',
      !host.tools.schemas({ id: 'root-b' }).map((s) => s.name).includes('mcp__late__tool')
    )
    host.tools.__register('mcp__late__tool')
    await settle()
    check(
      'tools/change: the late tool is hidden once it registers',
      !host.tools.schemas({ id: 'root-b' }).map((s) => s.name).includes('mcp__late__tool')
    )
    check(
      'tools/change: and it was visible before the switch was set',
      host.tools.schemas({ id: 'root-a' }).map((s) => s.name).includes('mcp__late__tool')
    )
    await post({ sessionId: 'root-b', deny: [] })
  }
  {
    // Disposal forgets the LINK but keeps the POLICY: the restriction is a user
    // decision about a session, while a finished child should not linger in the walk.
    await post({ sessionId: 'root-a', deny: ['write'] })
    check(
      'teardown: the child is restricted before disposal',
      typeof host.guards[0]({ name: 'write', agent: { id: 'child-a' } }) === 'string'
    )
    host.agents.dispose('child-a')
    check('teardown: the link is forgotten', !parents.has('child-a'))
    check('teardown: the policy survives', policies.has('root-a'))
    check(
      'teardown: the root is still restricted',
      typeof host.guards[0]({ name: 'write', agent: { id: 'root-a' } }) === 'string'
    )
    await post({ sessionId: 'root-a', deny: [] })
    await settle()
  }
} finally {
  await new Promise((resolve) => host.server.close(resolve))
}

// --- 4b. skills and prompt sections (protocol 8) ------------------------------
{
  // --- the frontmatter patcher: one top-level key, nothing else touched
  const plain = '---\nname: demo\ndescription: A demo.\n---\n\n# Demo\n'
  check(
    'skills: adds the key when absent',
    patchSkillFrontmatter(plain, false) ===
      '---\nname: demo\ndescription: A demo.\ndisable-model-invocation: true\n---\n\n# Demo\n',
    JSON.stringify(patchSkillFrontmatter(plain, false))
  )
  check(
    'skills: enabling writes the negation as false',
    patchSkillFrontmatter('---\nname: demo\ndisable-model-invocation: true\n---\nbody\n', true).includes(
      'disable-model-invocation: false'
    )
  )
  check(
    'skills: disabling writes the negation as true',
    patchSkillFrontmatter('---\nname: demo\ndisable-model-invocation: false\n---\n', false).includes(
      'disable-model-invocation: true'
    )
  )
  check(
    'skills: preserves CRLF',
    patchSkillFrontmatter('---\r\nname: demo\r\n---\r\nbody\r\n', false).includes(
      '\r\ndisable-model-invocation: true\r\n'
    )
  )
  check(
    'skills: preserves a BOM',
    patchSkillFrontmatter('\uFEFF---\nname: demo\n---\nbody\n', false).startsWith('\uFEFF---')
  )
  check('skills: refuses an unclosed block', patchSkillFrontmatter('---\nname: demo\nbody\n', false) === undefined)
  check('skills: refuses a file with no block', patchSkillFrontmatter('# Demo\n', false) === undefined)
  check(
    'skills: does not rewrite an indented lookalike',
    patchSkillFrontmatter('---\nname: demo\nmeta:\n  disable-model-invocation: false\n---\n', false) ===
      '---\nname: demo\nmeta:\n  disable-model-invocation: false\ndisable-model-invocation: true\n---\n',
    JSON.stringify(patchSkillFrontmatter('---\nname: demo\nmeta:\n  disable-model-invocation: false\n---\n', false))
  )
  check(
    'skills: only the targeted key changes',
    patchSkillFrontmatter('---\nname: demo\ndisable-model-invocation: true\nother: keep\n---\n', true) ===
      '---\nname: demo\ndisable-model-invocation: false\nother: keep\n---\n'
  )

  // --- the persisted disabled-section set
  check('prompts: normalizes a corrupt list', JSON.stringify(normalizePromptNames([1, ' a ', 'a', '', null])) === '["a"]')
  check(
    'prompts: bounds the list',
    normalizePromptNames(Array.from({ length: MAX_PROMPTS + 5 }, (_, index) => `s${index}`)).length === MAX_PROMPTS
  )
  check('prompts: an unusable payload becomes empty', JSON.stringify(normalizePromptNames({ a: 1 })) === '[]')
  savePrompts(new Set(['alpha']))
  check('prompts: the disabled set round-trips through disk', JSON.stringify(loadPrompts()) === '["alpha"]', JSON.stringify(loadPrompts()))
  savePrompts(new Set())
  check('prompts: the file lives under DSH_HOME', promptsFile().startsWith(SANDBOX), promptsFile())

  // --- skills over the real route
  const skillsRoot = fs.mkdtempSync(path.join(SANDBOX, 'skills-'))
  const alphaPath = path.join(skillsRoot, 'alpha', 'SKILL.md')
  fs.mkdirSync(path.dirname(alphaPath), { recursive: true })
  fs.writeFileSync(alphaPath, '---\nname: alpha\ndescription: An alpha skill.\n---\n\nDo alpha.\n')
  const fileEnabled = (file) => !/^disable-model-invocation:\s*true\s*$/m.test(fs.readFileSync(file, 'utf8'))
  host.extras.skills = {
    async snapshot() {
      return {
        complete: true,
        skills: [
          {
            name: 'alpha',
            description: 'An alpha skill.',
            provider: 'fs',
            source: 'project',
            path: alphaPath,
            invocation: { modelInvocable: fileEnabled(alphaPath), userInvocable: true }
          },
          {
            name: 'virtual',
            description: 'Registered by a plugin; no file.',
            provider: 'plugin',
            source: 'plugin',
            invocation: { modelInvocable: true, userInvocable: true }
          }
        ]
      }
    },
    registerProvider() {
      return () => {}
    }
  }
  host.extras.workingDirectory = { ensure: async () => skillsRoot }

  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve))
  const base2 = `http://127.0.0.1:${host.server.address().port}`
  const skillsGet = (sessionId) => fetch(`${base2}${SKILLS_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`)
  const skillsPost = (body, withHeader = true) =>
    fetch(`${base2}${SKILLS_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(withHeader ? { [HEADER]: '1' } : {}) },
      body: JSON.stringify(body)
    })
  const promptsGet = (sessionId) => fetch(`${base2}${PROMPTS_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`)
  const promptsPost = (body) =>
    fetch(`${base2}${PROMPTS_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [HEADER]: '1' },
      body: JSON.stringify(body)
    })

  try {
    const listed = await (await skillsGet('root-a')).json()
    check('skills route: lists the session', listed.ok === true && listed.state.available === true)
    check('skills route: carries the protocol', listed.state.protocol === PROTOCOL)
    check('skills route: one row per skill', listed.state.skills.length === 2, String(listed.state.skills.length))
    check(
      'skills route: a file-backed skill is toggleable',
      listed.state.skills.find((row) => row.name === 'alpha')?.toggleable === true
    )
    check(
      'skills route: a runtime skill is not toggleable',
      listed.state.skills.find((row) => row.name === 'virtual')?.toggleable === false
    )
    check('skills route: requires a session', (await fetch(`${base2}${SKILLS_ROUTE}`)).status === 400)
    check('skills route: a write requires the header', (await skillsPost({ sessionId: 'root-a', name: 'alpha', enabled: false }, false)).status === 403)
    check('skills route: a write needs a boolean', (await skillsPost({ sessionId: 'root-a', name: 'alpha', enabled: 'no' })).status === 400)
    check('skills route: an unknown skill is a 404', (await skillsPost({ sessionId: 'root-a', name: 'nope', enabled: false })).status === 404)
    check('skills route: a runtime skill is refused', (await skillsPost({ sessionId: 'root-a', name: 'virtual', enabled: false })).status === 409)

    const off = await (await skillsPost({ sessionId: 'root-a', name: 'alpha', enabled: false })).json()
    check('skills route: the switch reports it took effect', off.ok === true && off.applied === true, JSON.stringify(off.applied))
    check('skills route: the state says the skill is hidden', off.state.skills.find((row) => row.name === 'alpha')?.modelInvocable === false)
    check('skills route: the file now hides it from the model', fileEnabled(alphaPath) === false)
    check(
      'skills route: the frontmatter carries the key',
      fs.readFileSync(alphaPath, 'utf8').includes('disable-model-invocation: true')
    )

    const on = await (await skillsPost({ sessionId: 'root-a', name: 'alpha', enabled: true })).json()
    check('skills route: the switch can be turned back on', on.applied === true && fileEnabled(alphaPath) === true)

    // --- prompt sections over the same real route
    const promptGlobal = [
      { name: 'identity', order: 1, text: 'You are DSH.' },
      { name: 'tool-notes', order: 2, text: 'Use tools carefully.' },
      { name: 'workspace', order: 3, text: 'Workspace: /tmp/work' }
    ]
    const overlays = new Map()
    const shadowFails = new Set()
    host.extras.systemPrompt = {
      async assemble({ agent }) {
        const overlay = overlays.get(agent.id) ?? new Map()
        const merged = new Map()
        for (const section of promptGlobal) merged.set(section.name, section)
        for (const [name, definition] of overlay) merged.set(name, definition)
        return {
          sections: [...merged.values()]
            .sort((left, right) => left.order - right.order)
            .map((section) => ({ name: section.name, text: section.text }))
        }
      },
      __scoped(id) {
        return (definition) => {
          if (shadowFails.has(definition.name)) throw new Error('this section cannot be shadowed')
          const map = overlays.get(id) ?? new Map()
          overlays.set(id, map)
          map.set(definition.name, definition)
          return () => map.delete(definition.name)
        }
      }
    }

    replacePromptDisabled([])
    const promptList = await (await promptsGet('root-a')).json()
    check('prompts route: lists the assembled sections', promptList.ok === true && promptList.state.sections.length === 3, String(promptList.state.sections.length))
    check('prompts route: preserves assembly order', promptList.state.sections.map((row) => row.name).join(',') === 'identity,tool-notes,workspace')
    check('prompts route: everything starts enabled', promptList.state.sections.every((row) => row.enabled === true))
    check('prompts route: every section can be switched off', promptList.state.sections.every((row) => row.toggleable === true))
    check('prompts route: carries the protocol', promptList.state.protocol === PROTOCOL)

    const hidden = await (await promptsPost({ sessionId: 'root-a', name: 'identity', enabled: false })).json()
    check('prompts route: the switch reports it took effect', hidden.ok === true && hidden.applied === true)
    check(
      'prompts route: the section is now empty in the live prompt',
      (overlays.get('root-a')?.get('identity')?.text ?? 'not-shadowed') === ''
    )
    const hiddenRow = hidden.state.sections.find((row) => row.name === 'identity')
    check('prompts route: the row is off', hiddenRow?.enabled === false)
    check('prompts route: the row keeps its preview', hiddenRow?.chars > 0 && hiddenRow?.liveChars === 0, JSON.stringify(hiddenRow))
    check('prompts route: the other sections still carry text', hidden.state.sections.filter((row) => row.name !== 'identity').every((row) => row.liveChars > 0))
    check('prompts route: the disabled name is persisted', JSON.stringify(loadPrompts()) === '["identity"]', JSON.stringify(loadPrompts()))

    const shown = await (await promptsGet('root-a')).json()
    check('prompts route: a fresh read agrees with the switch', shown.state.sections.find((row) => row.name === 'identity')?.enabled === false)

    const restored = await (await promptsPost({ sessionId: 'root-a', name: 'identity', enabled: true })).json()
    check('prompts route: the switch can be turned back on', restored.applied === true)
    check('prompts route: the shadow is gone', !(overlays.get('root-a')?.has('identity') ?? false))
    check('prompts route: the text is back', restored.state.sections.find((row) => row.name === 'identity')?.liveChars > 0)

    // An unknown name must not persist a dead switch.
    check('prompts route: an unknown section is a 404', (await promptsPost({ sessionId: 'root-a', name: 'nope', enabled: false })).status === 404)
    check('prompts route: an unknown section persists nothing', getPromptDisabled().length === 0, JSON.stringify(getPromptDisabled()))

    // A section that cannot be shadowed is detected and rolled back.
    shadowFails.add('tool-notes')
    const refused = await promptsPost({ sessionId: 'root-a', name: 'tool-notes', enabled: false })
    check('prompts route: an unshadowable section is a 409', refused.status === 409, String(refused.status))
    check('prompts route: the refusal leaves no disabled name', getPromptDisabled().length === 0, JSON.stringify(getPromptDisabled()))
    check(
      'prompts route: the section still carries its text',
      (overlays.get('root-a')?.get('tool-notes')?.text ?? 'still live') !== ''
    )
    shadowFails.delete('tool-notes')

    // The reset switch restores every disabled section at once.
    await promptsPost({ sessionId: 'root-a', name: 'identity', enabled: false })
    await promptsPost({ sessionId: 'root-a', name: 'workspace', enabled: false })
    check('prompts route: two sections are off', getPromptDisabled().length === 2, JSON.stringify(getPromptDisabled()))
    const reset = await (await promptsPost({ sessionId: 'root-a', reset: true })).json()
    check('prompts route: reset restores everything', reset.ok === true && getPromptDisabled().length === 0)
    check('prompts route: reset re-enables every row', reset.state.sections.every((row) => row.enabled === true))
    check('prompts route: reset persisted the empty set', JSON.stringify(loadPrompts()) === '[]', JSON.stringify(loadPrompts()))
  } finally {
    replacePromptDisabled([])
    savePrompts(new Set())
    await new Promise((resolve) => host.server.close(resolve))
  }

  // --- the service-absent and no-session answers (direct, no route)
  check('skills: a deployment without the service says so', (await skillsState({}, 'x')).available === false)
  check('skills: no live agent is a stated reason', (await skillsState({ skills: { snapshot: async () => ({ skills: [] }) }, agents: { get: () => undefined } }, 'x')).reason === 'no-live-agent')
  check('prompts: a deployment without the service says so', (await promptsState({ agents: { get: () => undefined } }, 'x')).available === false)
  check(
    'prompts: no live agent is a stated reason',
    (await promptsState({ systemPrompt: { assemble: async () => ({ sections: [] }) }, agents: { get: () => undefined } }, 'x')).reason === 'no-live-agent'
  )
  check('prompts: a preview is bounded', MAX_SECTION_TEXT > 0)

  // --- the sole-section refusal happens BEFORE any write
  {
    const soleHost = {
      agents: { get: () => ({ id: 'solo' }) },
      systemPrompt: { assemble: async () => ({ sections: [{ name: 'only', order: 1, text: 'x' }] }) },
      prompts: { syncAll: () => {} }
    }
    replacePromptDisabled([])
    let refused
    try {
      await togglePromptSection(soleHost, 'solo', 'only', false)
    } catch (error) {
      refused = error
    }
    check('prompts: the only section cannot be switched off', refused !== undefined && refused.status === 409, String(refused?.status))
    check('prompts: the refusal wrote nothing', getPromptDisabled().length === 0, JSON.stringify(getPromptDisabled()))
  }
}

// --- 5. module-level helpers --------------------------------------------------
{
  policies.clear()
  parents.clear()
  check('owner: an unrestricted session owns itself', ownerOf('solo') === 'solo')
  policies.set('p', { deny: new Set(['write']), blocked: 0 })
  parents.set('c', 'p')
  check('owner: a child resolves to its restricted parent', ownerOf('c') === 'p')
  check('policyFor: the child gets the parent policy', policyFor('c').deny.has('write'))
  check('policyFor: an unrelated session gets nothing', policyFor('x') === undefined)
  check('denySetFor: an unrelated session gets the shared empty set', denySetFor('x') === EMPTY_DENY)
  const snap = snapshot('c')
  check('snapshot: names the asking session', snap.sessionId === 'c')
  check('snapshot: names the owning session', snap.ownerId === 'p')
  check('snapshot: flags inheritance', snap.inherited === true)
  check('snapshot: carries the protocol', snap.protocol === PROTOCOL)
  check('snapshot: an unrestricted session reports nothing denied', snapshot('free').denied.length === 0)
  policies.clear()
  parents.clear()
}


// --- 5b. the plugin tab, against a fake browser -------------------------------
// The plugin half was client-only in its own package; here it is the second tab of
// the same component, so these checks drive the SAME registered component and open
// the panel the way a user does (click the trigger), then switch to that tab.
{
  /** Parse an element tree the way `React.createElement` builds it. */
  function makeElement(type, props, ...children) {
    const element = { type, props: props ?? {}, children: children.flat() }
    const ref = element.props.ref
    if (ref !== undefined && ref !== null) {
      ref.current = {
        getBoundingClientRect: () => ({ top: 600, left: 40, right: 120, bottom: 632, width: 80, height: 32 }),
        contains: () => false
      }
    }
    return element
  }

  /**
   * Per-component hook state.
   *
   * A single shared array is not enough here: the panel renders two child tabs, and a
   * child's `useState` setter closes over the array it was created against. With one
   * global array, a child setter landing afterward writes into the PARENT's slot —
   * which is exactly how this harness first reported the panel's `open` as the
   * child's `status`. Keying by the component function gives each its own slots, the
   * way the real renderer does.
   */
  const hookStates = new WeakMap()
  let hookState = []
  let hookCursor = 0
  let effects = []
  let renderComponent
  let renderProps
  let currentTree

  /** The state array bound to one component (created on first render). */
  function stateFor(component, props) {
    let state = hookStates.get(component)
    if (state === undefined) {
      state = [...(props.seed ?? [])]
      state.__refs = new Map()
      state.__refCount = 0
      state.__memo = new Map()
      state.__callbacks = new Map()
      state.__effectDeps = new Map()
      hookStates.set(component, state)
    }
    return state
  }

  /**
   * Render one component against ITS OWN state.
   *
   * `first` resets that component's slots to `props.seed` — and ONLY that
   * component's: the panel and each tab are independent, so seeding one must never
   * blank another. (An earlier version cleared a shared array here, which made the
   * panel adopt the plugin tab's `status` as its own `open`.)
   */
  function renderPass(component, props, first) {
    hookCursor = 0
    if (first) {
      const fresh = [...(props.seed ?? [])]
      fresh.__refs = new Map()
      fresh.__refCount = 0
      fresh.__memo = new Map()
      fresh.__callbacks = new Map()
      fresh.__effectDeps = new Map()
      hookStates.set(component, fresh)
    }
    hookState = stateFor(component, props)
    hookState.__refCount = 0
    effects = []
    return component(props)
  }

  let rerenderScheduled = false
  function rerender() {
    if (rerenderScheduled) return
    rerenderScheduled = true
    queueMicrotask(() => {
      rerenderScheduled = false
      if (renderComponent === undefined) return
      currentTree = renderPass(renderComponent, renderProps, false)
    })
  }

  const fakeReact = {
    createElement: makeElement,
    useState(initial) {
      const index = hookCursor++
      // The setter must close over ITS OWN component's state array. Reading the
      // module-level `hookState` at call time instead is what let a tab's `setStatus`
      // write `'ready'` into the parent panel's `open` slot once the panel's own
      // state had been unbound by a child walk.
      const own = hookState
      if (own[index] === undefined) {
        own[index] = typeof initial === 'function' ? initial() : initial
      }
      const setter = (next) => {
        const resolved = typeof next === 'function' ? next(own[index]) : next
        if (resolved === own[index]) return
        own[index] = resolved
        rerender()
      }
      return [own[index], setter]
    },
    useRef(initial) {
      const own = hookState
      const key = 'ref' + own.__refCount++
      if (!own.__refs.has(key)) own.__refs.set(key, { current: initial })
      return own.__refs.get(key)
    },
    useCallback(fn) {
      // Memoized by SLOT, like React with a stable dependency list. Without this, a
      // tab's `useEffect(..., [active, load])` re-ran on every render (a new `load`
      // identity), so a GET clobbered the state a POST had just returned.
      const own = hookState
      const index = hookCursor++
      const key = 'callback' + index
      if (!own.__callbacks.has(key)) own.__callbacks.set(key, fn)
      return own.__callbacks.get(key)
    },
    useEffect(fn, deps) {
      // Dependency-aware, like React: `[]` runs once per mount and a stable list runs
      // only when it changes. Without this, every `pump` re-ran every effect, which
      // made a tab's GET race its own POST and overwrite the answer.
      const own = hookState
      const index = hookCursor++
      const key = 'effect' + index
      if (Array.isArray(deps)) {
        const previous = own.__effectDeps.get(key)
        const same =
          previous !== undefined &&
          previous.length === deps.length &&
          deps.every((dep, at) => Object.is(dep, previous[at]))
        if (same) return
        own.__effectDeps.set(key, [...deps])
      }
      effects.push(fn)
    },
    /**
     * Cache by dependency identity, like React.
     *
     * The panel builds its two tab components through `useMemo`, so a fake that
     * re-invoked the factory on every render would hand React a NEW component type
     * each time — the real renderer would unmount and remount both tabs, losing the
     * state and re-reading the plugin list.
     */
    useMemo(fn, deps) {
      const own = hookState
      const index = hookCursor++
      if (own.__memo === undefined) own.__memo = new Map()
      const memoKey = 'memo' + index
      const previous = own.__memo.get(memoKey)
      const same =
        previous !== undefined &&
        Array.isArray(deps) &&
        Array.isArray(previous.deps) &&
        deps.length === previous.deps.length &&
        deps.every((dep, at) => Object.is(dep, previous.deps[at]))
      if (same) return previous.value
      const value = fn()
      own.__memo.set(memoKey, { deps, value })
      return value
    }
  }
  const fakeReactDom = { createPortal: (node, container) => ({ portal: node, container }) }

  function makeDocument() {
    const head = { children: [], appendChild: (tag) => head.children.push(tag) }
    const body = { tag: 'body' }
    return {
      head,
      body,
      createElement: (type) => ({ type, dataset: {}, textContent: '' }),
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: () => null
    }
  }

  function makeStorage() {
    const map = new Map()
    return {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => map.set(key, String(value)),
      removeItem: (key) => map.delete(key),
      raw: (key, value) => map.set(key, value)
    }
  }

  /** Boot the bundle against a fake window and return its exports. */
  function bootClient() {
    // `setInterval`/`clearInterval` are needed by the tool tab's poll, which starts
    // as soon as that tab becomes visible.
    const win = {
      localStorage: makeStorage(),
      __ModuleLoader__: { load: () => {} },
      setInterval: () => 0,
      clearInterval: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      innerWidth: 1200,
      innerHeight: 900
    }
    let registration
    win.__ModuleLoader__ = { load: (value) => { registration = value } }
    const table = { react: fakeReact, 'react-dom': fakeReactDom }
    const require = (spec) => {
      if (!Object.hasOwn(table, spec)) throw new Error(`client requires an unexpected module: ${spec}`)
      return table[spec]
    }
    // eslint-disable-next-line no-new-func
    new Function('window', 'navigator', 'document', clientSource)(win, { language: 'zh-CN' }, makeDocument())
    if (registration === undefined) throw new Error('the bundle registered no module')
    return { id: registration.id, exports: registration.factory(require), window: win }
  }

  const booted = bootClient()
  check('plugin tab: the bundle ids itself', booted.id === 'dsh-plugin-tools-panel', booted.id)
  check('plugin tab: the bundle injects only slots', JSON.stringify(booted.exports.inject) === '["slots"]', JSON.stringify(booted.exports.inject))

  /** Drive `apply` and capture the single registration. */
  function driveApply({ locale, remotes, managementAvailable = true, inventoryList }) {
    const registrations = []
    const ctx = {
      effect(fn) {
        fn()
        return () => {}
      },
      get(name) {
        if (name === 'locale') return locale
        if (name === 'remote') {
          return {
            ...remotes,
            ...(inventoryList === undefined ? {} : { pluginInventory: { list: inventoryList } })
          }
        }
        return undefined
      },
      slots: {
        inject(slot, fn) {
          fn()
        },
        register(options, component) {
          registrations.push({ options, component })
          return () => {}
        }
      }
    }
    booted.exports.apply(ctx)
    return { registrations }
  }

  const fakeLocale = { getSnapshot: () => ({ active: 'zh-CN' }), register: () => () => {} }

  const bundles = [
    { name: 'dsh-better-sidebar', version: '0.26.0', meta: { title: { zh: '更好的侧边栏', en: 'Better sidebar' } }, enabled: true, installed: true },
    { name: 'dsh-client-auto-continue', version: '0.14.2', enabled: false, installed: true },
    { name: '@deepseek-ai/dsh-api-gateway', enabled: true, installed: false, readOnlyReason: 'management-required' },
    { name: 'some-library', enabled: false, installed: true, error: { code: 'not-bundle' } }
  ]

  /** The `t` seat is a translate FUNCTION, matching what the renderer hands over. */
  const DICT = {
    title: '工具面板',
    tabTools: '工具',
    tabSkills: '技能',
    tabPrompts: '提示词',
    tabPlugins: '插件',
    loading: 'l',
    empty: 'e',
    failed: 'f',
    retry: 'r',
    pluginsLoading: 'pl',
    pluginsEmpty: 'pe',
    pluginsSearch: '搜索插件',
    pluginsNoMatch: '没有匹配的插件',
    pluginsUnavailable: 'pu',
    pluginsManagementRequired: 'M',
    pluginsUnaddressable: 'A',
    pluginsNotBundle: 'N',
    pluginsFailed: 'pf',
    pluginsSwitchFailed: '失败：',
    pluginsOverridden: '{name} 被覆盖',
    pluginsCancelled: '{name} 已取消'
  }
  const tt = (key, params) => {
    const template = DICT[key]
    if (typeof template !== 'string') return key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  }

  function render(component, props = {}) {
    hookState = [...(props.seed ?? [])]
    hookCursor = 0
    effects = []
    renderComponent = component
    renderProps = props
    const tree = renderPass(component, props, true)
    currentTree = tree
    return {
      tree,
      runEffects: async () => {
        for (let round = 0; round < 6 && effects.length > 0; round++) {
          for (const fn of effects.splice(0)) fn()
          await new Promise((resolve) => setImmediate(resolve))
          currentTree = renderPass(component, props, false)
        }
      }
    }
  }

  function renderChild(node) {
    const savedCursor = hookCursor
    const savedState = hookState
    const savedEffects = effects
    hookCursor = 0
    hookState = stateFor(node.type, node.props)
    hookState.__refCount = 0
    effects = []
    const out = node.type(node.props)
    // A child's effects are collected while it renders; hand them back to the caller
    // so `runEffects` can run them (the real renderer commits them in the same pass).
    const childEffects = effects
    effects = savedEffects
    for (const fn of childEffects) savedEffects.push(fn)
    hookCursor = savedCursor
    hookState = savedState
    return out
  }

  /**
   * Drive the panel until its child tabs have run their effects.
   *
   * The real renderer mounts children immediately, so a tab's `useEffect` runs as
   * part of the same commit. This fake only instantiates a function component when
   * the tree is WALKED, so a tab's effect lands in `effects` on the walk, not on the
   * parent render. Pumping alternates "walk (so children render)" and "run effects"
   * until nothing new arrives — which is the same order the real renderer uses.
   */
  async function pump(view, rounds = 6) {
    for (let round = 0; round < rounds; round += 1) {
      byClass(currentTree, 'dsh-tools-panel-tabBody')
      await view.runEffects()
      await new Promise((resolve) => setImmediate(resolve))
      // Re-render the panel itself: the walk above bound `hookState` to whichever
      // child rendered last, and `runEffects` may have flipped a child's state. One
      // parent pass puts the tree (and the bound state) back on the panel.
      currentTree = renderPass(renderComponent, renderProps, false)
    }
  }

  function byClass(node, className, found = []) {
    if (node === null || node === undefined || typeof node !== 'object') return found
    if (Array.isArray(node)) {
      for (const child of node) byClass(child, className, found)
      return found
    }
    if (node.portal !== undefined) return byClass(node.portal, className, found)
    if (typeof node.type === 'function') return byClass(renderChild(node), className, found)
    const classes = String(node.props?.className ?? '').split(/\s+/)
    if (classes.includes(className)) found.push(node)
    for (const child of node.children ?? []) byClass(child, className, found)
    return found
  }

  function textOf(node, out = []) {
    if (typeof node === 'string') {
      out.push(node)
      return out
    }
    if (node === null || node === undefined || typeof node !== 'object') return out
    if (Array.isArray(node)) {
      for (const child of node) textOf(child, out)
      return out
    }
    if (node.portal !== undefined) return textOf(node.portal, out)
    if (typeof node.type === 'function') return textOf(renderChild(node), out)
    for (const child of node.children ?? []) textOf(child, out)
    return out
  }

  const probe = driveApply({
    locale: fakeLocale,
    remotes: {
      pluginManager: {
        listBundles: async () => ({ ok: true, value: bundles }),
        setBundleEnabled: async (name, enabled) => ({
          ok: true,
          value: { changed: true, application: 'applied', stage: 'enable', target: name, enabled }
        })
      }
    },
    inventoryList: async () => ({ ok: true, value: { entries: [], managementAvailable: true } })
  })
  check('plugin tab: apply registers exactly one entry', probe.registrations.length === 1, String(probe.registrations.length))
  const entry = probe.registrations[0]
  check('plugin tab: the entry is the merged panel', entry.options.id === 'tools-panel', entry.options.id)
  check('plugin tab: the entry declares the merged locale namespace', entry.options.locale === 'toolsPanel', entry.options.locale)
  check('plugin tab: the entry carries no shadowing priority', entry.options.priority === undefined)

  const Component = entry.component

  /**
   * Make `tab` the remembered one before a block asserts that tab's content.
   *
   * The panel deliberately opens on the LAST tab used, so a block that ran after a
   * tab-switch test would otherwise find the other tab selected — the product
   * behaving correctly, and the test reading the wrong pane.
   */
  function rememberTab(tab) {
    booted.window.localStorage.setItem('dsh-plugin-tools-panel/tab', tab)
  }

  // Closed by default: one trigger, no menu, nothing read yet.
  {
    const view = render(Component, { t: tt })
    const triggers = byClass(view.tree, 'dsh-tools-panel-trigger')
    check('panel: shows one trigger', triggers.length === 1, String(triggers.length))
    check('panel: closed by default', triggers[0].props['aria-expanded'] === false)
    check('panel: no menu while closed', byClass(view.tree, 'dsh-tools-panel-menu').length === 0)
  }

  // Open: a portal with a four-tab strip, and the DEFAULT tab is plugins.
  {
    const view = render(Component, { t: tt })
    byClass(view.tree, 'dsh-tools-panel-trigger')[0].props.onClick()
    await pump(view)
    const menu = byClass(currentTree, 'dsh-tools-panel-menu')
    check('panel: opening renders one portalled menu', menu.length === 1, String(menu.length))
    check('panel: portalled out of the composer row', currentTree.children.some((child) => child?.container?.tag === 'body'))
    const tabs = byClass(currentTree, 'dsh-tools-panel-tab')
    check('panel: the menu carries exactly four tabs', tabs.length === 4, String(tabs.length))
    check('panel: the tabs are a tablist', byClass(currentTree, 'dsh-tools-panel-tabs')[0]?.props?.role === 'tablist')
    // The user asked for plugins as the default tab.
    check('panel: the default tab is plugins', tabs[3].props['aria-selected'] === true, tabs.map((tab) => tab.props['aria-selected']).join(','))
    check('panel: the tools tab is not selected', tabs[0].props['aria-selected'] === false)
    check('panel: the tab order is tools, skills, prompts, plugins', textOf(tabs[0]).join('') === '工具' && textOf(tabs[1]).join('') === '技能' && textOf(tabs[2]).join('') === '提示词' && textOf(tabs[3]).join('') === '插件', tabs.map((tab) => textOf(tab).join('')).join('|'))
    check('panel: tab ids are stable', tabs.every((tab) => tab.props.role === 'tab'))
  }

  // Switching tabs keeps BOTH mounted, and remembers the choice.
  {
    const view = render(Component, { t: tt })
    byClass(view.tree, 'dsh-tools-panel-trigger')[0].props.onClick()
    await pump(view)
    const tabs = byClass(currentTree, 'dsh-tools-panel-tab')
    tabs[0].props.onClick()
    await new Promise((resolve) => setImmediate(resolve))
    const after = byClass(currentTree, 'dsh-tools-panel-tab')
    check('panel: clicking a tab selects it', after[0].props['aria-selected'] === true, after.map((tab) => tab.props['aria-selected']).join(','))
    // Both tab bodies exist at all times: the inactive one is hidden with `display`,
    // so its state and its loaded list survive a switch.
    check('panel: all four tab bodies stay mounted', byClass(currentTree, 'dsh-tools-panel-tabBody').length === 4, String(byClass(currentTree, 'dsh-tools-panel-tabBody').length))
    check('panel: the last tab is persisted', booted.window.localStorage.getItem('dsh-plugin-tools-panel/tab') === 'tools', String(booted.window.localStorage.getItem('dsh-plugin-tools-panel/tab')))
    // A fresh mount restores it.
    const again = render(Component, { t: tt })
    byClass(again.tree, 'dsh-tools-panel-trigger')[0].props.onClick()
    await pump(again)
    const restored = byClass(currentTree, 'dsh-tools-panel-tab')
    check('panel: a reopen restores the remembered tab', restored[0].props['aria-selected'] === true, restored.map((tab) => tab.props['aria-selected']).join(','))
  }

  // The plugin tab's own behaviour: the toggle calls the official Remote.
  {
    rememberTab('plugins')
    const toggled = []
    const recording = driveApply({
      locale: fakeLocale,
      remotes: {
        pluginManager: {
          listBundles: async () => ({ ok: true, value: bundles }),
          setBundleEnabled: async (name, enabled) => {
            toggled.push({ name, enabled })
            return { ok: true, value: { changed: true, application: 'applied', stage: 'enable', target: name, enabled } }
          }
        }
      },
      inventoryList: async () => ({ ok: true, value: { entries: [], managementAvailable: true } })
    })
    const comp = recording.registrations[0].component
    const view = render(comp, { t: tt })
    byClass(view.tree, 'dsh-tools-panel-trigger')[0].props.onClick()
    await pump(view)
    const switches = byClass(currentTree, 'dsh-tools-panel-plugin-switch')
    // Two rows, not four: the fixture carries a read-only infrastructure row and a
    // plain library row, and BOTH are dropped. Infrastructure is never a dependency
    // of the profile (`installed:false`), and a package with no plugin patch is not a
    // plugin — offering either would be a switch that cannot work.
    check('plugin tab: one switch per installed row', switches.length === 2, String(switches.length))
    check('plugin tab: switch state mirrors enabled', switches.map((s) => s.props['aria-checked']).join(',') === 'true,false', switches.map((s) => s.props['aria-checked']).join(','))
    check('plugin tab: switchable rows are enabled', switches.every((s) => s.props.disabled === false), JSON.stringify(switches.map((s) => s.props.disabled)))
    switches[1].props.onClick()
    await new Promise((resolve) => setImmediate(resolve))
    check('plugin tab: the toggle asks for the inverse state', toggled.length === 1 && toggled[0].enabled === true, JSON.stringify(toggled))
    check('plugin tab: it names the package, not the entry id', toggled[0]?.name === 'dsh-client-auto-continue', toggled[0]?.name)
    // Infrastructure and non-plugin packages never reach the list.
    const shown = textOf(currentTree).join('|')
    check('plugin tab: infrastructure is not offered', !shown.includes('dsh-api-gateway'), shown.slice(0, 120))
    check('plugin tab: a non-plugin package is not offered', !shown.includes('some-library'), shown.slice(0, 120))

    // The plugin list is searchable by package name and by localized title.
    const pluginSearch = byClass(currentTree, 'dsh-tools-panel-tool-search').find(
      (node) => node.props.placeholder === '搜索插件'
    )
    check('plugin tab: offers a search box', pluginSearch !== undefined)
    pluginSearch.props.onChange({ target: { value: 'sidebar' } })
    await pump(view)
    check(
      'plugin tab: searching narrows the list',
      byClass(currentTree, 'dsh-tools-panel-plugin-switch').length === 1,
      String(byClass(currentTree, 'dsh-tools-panel-plugin-switch').length)
    )
    check(
      'plugin tab: the filtered-out row is gone',
      !textOf(currentTree).some((text) => text.includes('dsh-client-auto-continue'))
    )
    pluginSearch.props.onChange({ target: { value: 'zzz' } })
    await pump(view)
    check('plugin tab: no match is stated', textOf(currentTree).some((text) => text.includes('没有匹配的插件')))
  }

  // Uninstalled runtime shells must never be offered: composing one kills the Host.
  {
    rememberTab('plugins')
    const shells = [
      { name: '@deepseek-ai/dsh-acp-app', version: '0.2.1', enabled: false, installed: false },
      { name: '@deepseek-ai/dsh-headless', version: '0.2.1', enabled: false, installed: false },
      { name: '@deepseek-ai/dsh-sdk-app', version: '0.2.1', enabled: false, installed: false },
      { name: 'dsh-edit-retry', version: '0.3.2', enabled: true, installed: true }
    ]
    const shellProbe = driveApply({
      locale: fakeLocale,
      remotes: { pluginManager: { listBundles: async () => ({ ok: true, value: shells }) } },
      inventoryList: async () => ({ ok: true, value: { entries: [], managementAvailable: true } })
    })
    const comp = shellProbe.registrations[0].component
    const view = render(comp, { t: tt })
    byClass(view.tree, 'dsh-tools-panel-trigger')[0].props.onClick()
    await pump(view)
    const rows = byClass(currentTree, 'dsh-tools-panel-plugin-row')
    check('plugin tab: the menu rendered its rows', rows.length === 1, String(rows.length))
    check('plugin tab: the installed plugin is kept', textOf(currentTree).some((s) => s.includes('dsh-edit-retry')))
    check('plugin tab: no runtime shell reaches the list', !textOf(currentTree).some((s) => s.includes('acp-app') || s.includes('headless') || s.includes('sdk-app')))
  }

  // Pinning: independent of the switch, persisted, survives a reopen.
  {
    rememberTab('plugins')
    const fixture = [
      { name: 'dsh-better-sidebar', version: '0.26.0', enabled: true, installed: true, meta: { title: '更好的侧边栏' } },
      { name: 'dsh-edit-retry', version: '0.3.2', enabled: false, installed: true, meta: { title: '重试' } }
    ]
    const pinProbe = driveApply({
      locale: fakeLocale,
      remotes: { pluginManager: { listBundles: async () => ({ ok: true, value: fixture }) } },
      inventoryList: async () => ({ ok: true, value: { entries: [], managementAvailable: true } })
    })
    const comp = pinProbe.registrations[0].component
    const view = render(comp, { t: tt })
    byClass(view.tree, 'dsh-tools-panel-trigger')[0].props.onClick()
    await pump(view)
    const titles = () => byClass(currentTree, 'dsh-tools-panel-plugin-row').map((node) => byClass(node, 'dsh-tools-panel-plugin-name')[0]?.children?.[0])
    check('plugin tab: the list starts enabled-first', titles()[0] === '更好的侧边栏', titles().join('|'))
    const pin = byClass(byClass(currentTree, 'dsh-tools-panel-plugin-row')[1], 'dsh-tools-panel-plugin-pin')[0]
    check('plugin tab: the pin is a plain button', pin.type === 'button' && pin.props.role === undefined)
    pin.props.onClick()
    await new Promise((resolve) => setImmediate(resolve))
    check('plugin tab: pinning a disabled row moves it to the top', titles()[0] === '重试', titles().join('|'))
    check('plugin tab: the pin is persisted', booted.window.localStorage.getItem('dsh-plugin-tools-panel/pinned') === '["dsh-edit-retry"]', String(booted.window.localStorage.getItem('dsh-plugin-tools-panel/pinned')))
  }

  // The panel keeps working with NO plugin manager: the tools tab must still open.
  {
    rememberTab('plugins')
    const noRemote = driveApply({ locale: fakeLocale, remotes: {} })
    const comp = noRemote.registrations[0].component
    const view = render(comp, { t: tt })
    byClass(view.tree, 'dsh-tools-panel-trigger')[0].props.onClick()
    await pump(view)
    check('plugin tab: a deployment without a manager still opens the panel', byClass(currentTree, 'dsh-tools-panel-menu').length === 1)
    // No manager at all: the honest report is an error with the reason, not an
    // "unavailable" notice (that one is for a Host that HAS a manager but manages no
    // profile). Either way the panel must stay open — that is the assertion that
    // matters here, because a closed menu would hide the tools tab too.
    check(
      'plugin tab: and explains why it cannot list plugins',
      textOf(currentTree).some((s) => s.includes('no plugin manager')),
      textOf(currentTree).slice(0, 8).join('|')
    )
    check('panel: the tools tab is still there', byClass(currentTree, 'dsh-tools-panel-tab').length === 4)
  }

  // The skills tab: one row per skill, one switch per row, and the switch is a POST.
  {
    rememberTab('plugins')
    const calls = []
    const listed = {
      protocol: 8,
      sessionId: 's1',
      available: true,
      complete: true,
      skills: [
        { name: 'alpha', description: 'An alpha skill.', provider: 'fs', source: 'project', path: '/tmp/SKILL.md', modelInvocable: true, userInvocable: true, toggleable: true },
        { name: 'virtual', description: 'Registered at runtime.', provider: 'plugin', source: 'plugin', modelInvocable: true, userInvocable: true, toggleable: false }
      ]
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init })
      if (init.method === 'POST') {
        const body = JSON.parse(init.body)
        return {
          status: 200,
          json: async () => ({
            ok: true,
            applied: true,
            state: {
              ...listed,
              skills: listed.skills.map((skill) =>
                skill.name === body.name ? { ...skill, modelInvocable: body.enabled } : skill
              )
            }
          })
        }
      }
      return { status: 200, json: async () => ({ ok: true, state: listed }) }
    }
    try {
      const comp = driveApply({ locale: fakeLocale, remotes: {} }).registrations[0].component
      const view = render(comp, { t: tt, sessionId: 's1' })
      byClass(view.tree, 'dsh-tools-panel-trigger')[0].props.onClick()
      await pump(view)
      byClass(currentTree, 'dsh-tools-panel-tab')[1].props.onClick()
      await pump(view)
      const rows = byClass(currentTree, 'dsh-tools-panel-skill-row')
      check('skills tab: one row per skill', rows.length === 2, String(rows.length))
      check('skills tab: the row shows the description', textOf(currentTree).some((text) => text.includes('An alpha skill.')))
      const switches = byClass(currentTree, 'dsh-tools-panel-tool-switch')
      const alphaSwitch = switches.find((node) => node.props['aria-label'] === 'alpha')
      const virtualSwitch = switches.find((node) => node.props['aria-label'] === 'virtual')
      check('skills tab: a file-backed row is switchable', alphaSwitch?.props.disabled === false)
      check('skills tab: a runtime row is not switchable', virtualSwitch?.props.disabled === true)
      check('skills tab: it reads the skills route with the session', calls.some((call) => call.url.includes('/skills?sessionId=s1')), calls.map((call) => call.url).join('|'))
      alphaSwitch.props.onClick()
      await pump(view)
      const post = calls.find((call) => call.init.method === 'POST')
      check('skills tab: the switch posts the exact skill and state', JSON.parse(post?.init.body ?? '{}').name === 'alpha' && JSON.parse(post?.init.body ?? '{}').enabled === false, post?.init.body)
      check(
        'skills tab: the host answer updates the switch',
        byClass(currentTree, 'dsh-tools-panel-tool-switch').find((node) => node.props['aria-label'] === 'alpha')?.props['aria-checked'] === false,
        String(byClass(currentTree, 'dsh-tools-panel-tool-switch').find((node) => node.props['aria-label'] === 'alpha')?.props['aria-checked'])
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  // A refusal on the skills route is a stated reason, not a "restart DSH" message.
  {
    rememberTab('skills')
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init = {}) => {
      if (init.method === 'POST') {
        return { status: 409, json: async () => ({ ok: false, error: 'this skill has no file to edit' }) }
      }
      return {
        status: 200,
        json: async () => ({
          ok: true,
          state: {
            protocol: 8,
            sessionId: 's1',
            available: true,
            skills: [{ name: 'alpha', description: 'd', path: '/tmp/SKILL.md', modelInvocable: true, userInvocable: true, toggleable: true }]
          }
        })
      }
    }
    try {
      const comp = driveApply({ locale: fakeLocale, remotes: {} }).registrations[0].component
      const view = render(comp, { t: tt, sessionId: 's1' })
      byClass(view.tree, 'dsh-tools-panel-trigger')[0].props.onClick()
      await pump(view)
      const sw = byClass(currentTree, 'dsh-tools-panel-tool-switch').find((node) => node.props['aria-label'] === 'alpha')
      sw.props.onClick()
      await pump(view)
      check(
        'skills tab: a refused write shows the Host reason',
        textOf(currentTree).some((text) => text.includes('this skill has no file to edit')),
        textOf(currentTree).slice(-4).join('|')
      )
      check('skills tab: a refusal is not mistaken for a version skew', !textOf(currentTree).some((text) => text.includes('staleHost')))
      check(
        'skills tab: a refused write rolls the switch back',
        byClass(currentTree, 'dsh-tools-panel-tool-switch').find((node) => node.props['aria-label'] === 'alpha')?.props['aria-checked'] === true
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  }
}

// --- 6. the client half's wiring ----------------------------------------------
check('client: uses the documented list-slot id field', clientSource.includes('id: ID'), 'id, not key')
check('client: the slot is conversation.input.right', clientSource.includes("const SLOT = 'conversation.input.right'"))
check('client: the slot id is its own', clientSource.includes("const ID = 'tools-panel'"))
check('client: does not set a priority (would shadow a shipped entry)', !/priority:/.test(clientSource))
check('client: the route matches the host half', clientSource.includes(`const ROUTE = '${ROUTE}'`))
check('client: portals the menu out of the composer containment context', clientSource.includes('createPortal'))
check('client: reads state with GET', clientSource.includes("method: 'GET'"))
check('client: writes state with POST', clientSource.includes("method: 'POST'"))
check('client: sends the required header', clientSource.includes('[HEADER]:'), HEADER)
// The menu is a per-tool list: one row component, rendered from the Host's list.
check('client: renders one row per tool', clientSource.includes('function ToolRow('))
// Rows are drawn twice now: inside each group, and for the tools no group claims.
// Both map real names from the Host's list — nothing is invented client-side.
check(
  'client: maps the Host tool list into rows',
  /ungrouped\.map\(\(name\)/.test(clientSource) && /rows\.map\(\(name\)/.test(clientSource)
)
check('client: draws user groups', clientSource.includes('function GroupRow('))
check('client: a group row is a container, not a filter', /grouped\.has\(name\)/.test(clientSource))
check('client: groups are created from a multi-selection', clientSource.includes('toggleSelected'))
check('client: a group has one bulk switch', /onToggleAll/.test(clientSource))
check('client: a group can be renamed and removed', /onRename/.test(clientSource) && /onRemove/.test(clientSource))
check('client: group writes go to the host', clientSource.includes('writeGroups('))
check('client: offers a search filter', clientSource.includes("type: 'search'"))
check('client: offers a bulk action', clientSource.includes('flipAll'))
check('client: the list scrolls inside the menu', /\.dsh-tools-panel-tool-list\s*\{[^}]*max-height/m.test(clientSource))
// The old grouped switches must not come back: this revision exists to remove them.
check('client: no group switches left', !/allow(Read|Write|Shell|Agent)/.test(clientSource))
check('client: no per-row hint line', !/readHint|writeHint|shellHint|agentHint/.test(clientSource))
// Scoping: every request must name the session, or the Host would edit a
// process-wide policy instead of this conversation's.
check('client: takes the slot sessionId seat', /\{\s*t: seat,\s*sessionId\s*\}/.test(clientSource))
check('client: sends the session on GET', clientSource.includes('?sessionId='))
check('client: sends the session on POST', clientSource.includes('...patch, sessionId') || clientSource.includes('sessionId, deny'))
check('client: does not hardcode a session id', !/sessionId:\s*['"]/.test(clientSource))
// The inherited notice: editing a subagent's list edits its parent, so the menu has
// to say so rather than let that read as an unrelated session changing.
check('client: surfaces an inherited policy', clientSource.includes("t('inherited')"))
check('client: the icon-only trigger keeps an accessible name', clientSource.includes("'aria-label': t('title')"))
check(
  'client: every t() key exists in a dictionary',
  [...new Set([...clientSource.matchAll(/\bt\('(\w+)'/g)].map((m) => m[1]))].every((key) =>
    new RegExp(`\\n\\s+${key}:`).test(clientSource)
  ),
  [...new Set([...clientSource.matchAll(/\bt\('(\w+)'/g)].map((m) => m[1]))].join(', ')
)

// The merge itself: one entry, two tabs, no leftover group/plugin identity.
check('merge: one slot registration', (clientSource.match(/ctx\.slots\.inject\(/g) ?? []).length === 1)
check('merge: the entry id is the panel', clientSource.includes("const ID = 'tools-panel'"))
check('merge: one locale namespace', (clientSource.match(/const NS = /g) ?? []).length === 1)
check('merge: the namespace is the panel', clientSource.includes("const NS = 'toolsPanel'"))
check('merge: one stylesheet id', (clientSource.match(/const CSS_ID = /g) ?? []).length === 1)
check('merge: one trigger element', (clientSource.match(/className: 'dsh-tools-panel-trigger'/g) ?? []).length === 1)
check('merge: all four tabs are registered', ['tools', 'skills', 'prompts', 'plugins'].every((id) => clientSource.includes(`tabButton('${id}'`)))
check('merge: tabs are a tablist', clientSource.includes("role: 'tablist'"))
check('merge: inactive tab bodies stay mounted', /display: 'none'/.test(clientSource))
check('merge: no old package id survives', !clientSource.includes("id: 'dsh-tool-guard'") && !clientSource.includes("id: 'dsh-plugin-switch'"))
check('merge: the old class prefixes are gone', !clientSource.includes('dsh-tool-guard-') && !clientSource.includes('dsh-plugin-switch-'))

// Scrolling: each tab's list must be a flex child that can shrink, or the menu's
// `overflow: hidden` silently clips the tail of a long list (that is exactly the bug
// where the plugin tab could not scroll and the tool tab stopped short).
check(
  'scroll: the shell body can shrink',
  /\.dsh-tools-panel-body\s*\{[^}]*flex:\s*1 1 auto[^}]*min-height:\s*0/m.test(clientSource)
)
check(
  'scroll: a tab body can shrink',
  /\.dsh-tools-panel-tabBody\s*\{[^}]*flex:\s*1 1 auto[^}]*min-height:\s*0/m.test(clientSource)
)
check(
  'scroll: the tool list scrolls inside the menu',
  /\.dsh-tools-panel-tool-list\s*\{[^}]*overflow-y:\s*auto/m.test(clientSource) &&
    /\.dsh-tools-panel-tool-list\s*\{[^}]*flex:\s*1 1 auto/m.test(clientSource)
)
check(
  'scroll: the plugin list scrolls inside the menu',
  /\.dsh-tools-panel-plugin-list\s*\{[^}]*overflow-y:\s*auto/m.test(clientSource) &&
    /\.dsh-tools-panel-plugin-list\s*\{[^}]*flex:\s*1 1 auto/m.test(clientSource)
)
// A second, independent viewport-unit cap is what made the list stop short of the
// visible area, so no list may carry one.
// The entry/exit labels say what the gesture DOES (create / cancel a group) rather
// than naming a mode the user never asked for.
check(
  'panel: the entry button says "create group"',
  clientSource.includes("select: '创建分组'") && clientSource.includes("select: 'New group'"),
  'select -> 创建分组 / New group'
)
check(
  'panel: the exit button says "cancel create"',
  clientSource.includes("clearSelection: '取消创建'") && clientSource.includes("clearSelection: 'Cancel'"),
  'clearSelection -> 取消创建 / Cancel'
)

// The count badge was removed at the user's request; the inherited notice stays,
// because that one says whose policy these switches are.
check('panel: no count badge', !/tool-count/.test(clientSource) && !/\$\{denied\.size\}\//.test(clientSource))
check('panel: the inherited notice stays', clientSource.includes("t('inherited')"))

check(
  'scroll: the tab pane is a flex participant',
  /\.dsh-tools-panel-pane\s*\{[^}]*flex:\s*1 1 auto[^}]*min-height:\s*0/m.test(clientSource),
  'an unstyled wrapper breaks flex:1 for everything under it'
)
check(
  'scroll: every pane carries the class',
  (clientSource.match(/className: 'dsh-tools-panel-pane'/g) ?? []).length === 4,
  String((clientSource.match(/className: 'dsh-tools-panel-pane'/g) ?? []).length)
)
check(
  'scroll: the menu gets a definite height, not only a max',
  /height: `\$\{anchor\.maxHeight\}px`/.test(clientSource) &&
    /maxHeight: `\$\{anchor\.maxHeight\}px`/.test(clientSource),
  'max-height alone gives flex children nothing to divide'
)
check(
  'scroll: no list caps itself in viewport units',
  // Comments are stripped first: the rule's own comment explains why the cap is gone,
  // and a naive /max-height/ over the whole block matched that explanation.
  !/\.dsh-tools-panel-(tool|plugin)-list\s*\{[^}]*max-height/m.test(
    clientSource.replace(/\/\*[\s\S]*?\*\//g, '')
  ),
  'max-height inside a list rule'
)

// The client bundle is a classic script evaluated by the loader; a syntax error
// there is a dead control with no build step to catch it.
try {
  // eslint-disable-next-line no-new-func
  new Function(clientSource)
  check('client: parses as a script', true)
} catch (error) {
  check('client: parses as a script', false, String(error?.message ?? error))
}

// Never leave the sandbox behind: it holds a file this test wrote on purpose.
try {
  fs.rmSync(SANDBOX, { recursive: true, force: true })
} catch {
  /* a leaked temp dir is the OS's problem, not a test failure */
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
