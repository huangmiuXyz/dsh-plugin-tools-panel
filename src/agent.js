/**
 * The model-facing half: one tool that manages the user's tool groups.
 *
 * WHY IT IS A SEPARATE LOADER ROW
 *   The control in the composer and this tool are two different features that
 *   happen to share one storage file. Shipping them as one row would mean the only
 *   way to stop an agent from rearranging the user's groups is to switch off the
 *   kill switch with it — so this file is its own entry in `cordis.patch.yml`, and
 *   the shipped Plugins page can disable it on its own.
 *
 * WHAT A GROUP IS (and is not)
 *   A name plus a list of tool names, shown in the panel's Tools tab. It is
 *   ORGANIZATION, not policy: being in a group never disables a tool, and one tool
 *   may sit in several groups. The global deny set is a different thing and is not
 *   touched from here.
 *
 * WHY ONE TOOL AND NOT FIVE
 *   Six tools that all edit one small JSON document would each cost a schema in
 *   every request. One tool with an `action` costs one, and the action vocabulary
 *   is small enough to state in a parameter description.
 */
import {
  MAX_GROUPS,
  MAX_GROUP_NAME,
  MAX_NAME,
  MAX_TOOLS,
  getGroups,
  replaceGroups
} from './index.js'

/** Every action this tool accepts, in menu order. */
const ACTIONS = ['list', 'get', 'create', 'rename', 'set_members', 'add_members', 'remove_members', 'delete']

/**
 * Read a group name off the arguments.
 *
 * Throws rather than clamping: a name silently shortened to 60 characters is a
 * group the caller did not ask for, and it would then be un-findable by the name it
 * just used.
 * @returns the trimmed name.
 */
function readName(value) {
  if (typeof value !== 'string') throw new Error('`name` is required for this action: it must be a string')
  const name = value.trim()
  if (name.length === 0) throw new Error('`name` must not be empty')
  if (name.length > MAX_GROUP_NAME) {
    throw new Error(`a group name may be at most ${MAX_GROUP_NAME} characters; "${name}" is ${name.length}`)
  }
  return name
}

/**
 * Read a member list off the arguments.
 *
 * Names are NOT checked against the registry: a group may legitimately name a tool
 * that is not mounted right now (an MCP server that is disconnected today), and
 * dropping those members would quietly destroy the user's grouping the first time
 * a server failed to connect.
 * @returns the cleaned names, trimmed and deduplicated.
 */
function readMembers(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('`members` must be an array of tool names')
  const names = []
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const name = entry.trim()
    if (name.length === 0 || seen.has(name)) continue
    if (name.length > MAX_NAME) {
      throw new Error(`an entry in \`members\` is longer than ${MAX_NAME} characters: "${name.slice(0, 40)}…"`)
    }
    seen.add(name)
    names.push(name)
    if (names.length > MAX_TOOLS) throw new Error(`a group may hold at most ${MAX_TOOLS} tools`)
  }
  return names
}

/**
 * Resolve the `group` argument to one definition.
 *
 * Accepts the id or the exact name (case-insensitive), because a caller that just
 * created "Git" should not have to read an id back out of a previous answer.
 * @returns the live definition from `list`.
 */
function findGroup(list, value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('`group` is required for this action: give a group id or its exact name')
  }
  const key = value.trim()
  const byId = list.find((group) => group.id === key)
  if (byId !== undefined) return byId
  const lowered = key.toLowerCase()
  const byName = list.filter((group) => group.name.toLowerCase() === lowered)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    throw new Error(`several groups are named "${key}"; pass one id instead: ${byName.map((group) => group.id).join(', ')}`)
  }
  const known = list.map((group) => `"${group.name}"`).join(', ')
  throw new Error(`no group matches "${key}"; known groups: ${known.length === 0 ? '(none)' : known}`)
}

/** The shape returned to the caller: a copy, never the live definition. */
function summarize(list) {
  return list.map((group) => ({
    id: group.id,
    name: group.name,
    memberCount: group.members.length,
    members: [...group.members]
  }))
}

/** Refuse a name another group already uses, so `group` stays unambiguous. */
function assertNameFree(list, name, exceptId) {
  const taken = list.some((group) => group.id !== exceptId && group.name.toLowerCase() === name.toLowerCase())
  if (taken) throw new Error(`a group named "${name}" already exists; pick another name or edit that one`)
}

/** The tool definition handed to `ctx.tools.register()`. */
const definition = {
  name: 'manage_tool_groups',
  description:
    'Create, edit, and delete the tool GROUPS shown in the user\'s tool panel — named sets of tool names. ' +
    'A group is organization only: it never disables a tool, and one tool may belong to several groups. ' +
    'Changes are saved and appear in the panel right away. Query with `list` or `get` before editing: ' +
    'a group is addressed by its id or its exact name.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description:
          'list: every group with its members. ' +
          'get: one group. ' +
          'create: a new group; needs name, takes optional members. ' +
          'rename: needs group and the new name. ' +
          'set_members: replaces a group\'s members. ' +
          'add_members / remove_members: adjust the members of one group. ' +
          'delete: removes the group; the tools themselves stay available.'
      },
      group: {
        type: 'string',
        description: 'Group id or exact name. Required by every action except `list` and `create`.'
      },
      name: {
        type: 'string',
        description:
          `Group name, 1-${MAX_GROUP_NAME} characters, unique among groups. ` +
          'Required by `create` (the new name) and `rename` (the name it should have).'
      },
      members: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Tool names. ' +
          'create: the initial members, default none. ' +
          'set_members: the complete new list. ' +
          'add_members / remove_members: the names to add or drop. ' +
          'A name no tool currently provides is kept as written, so a group survives a disconnected MCP server.'
      }
    }
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'message', 'groups'],
      properties: {
        ok: { type: 'boolean', description: 'Whether the action was applied.' },
        message: { type: 'string', description: 'One sentence describing what happened.' },
        groups: {
          type: 'array',
          description: 'Every group as it stands now, so the next action needs no extra read.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'name', 'memberCount', 'members'],
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              memberCount: { type: 'number' },
              members: { type: 'array', items: { type: 'string' } }
            }
          }
        }
      }
    },
    render(args, value) {
      // A read is the case where the member lists ARE the answer; an edit already
      // said what changed, so repeating every group's every member is noise.
      const showMembers = args?.action === 'list' || args?.action === 'get'
      const lines = [value.message]
      if (value.groups.length > 0 && showMembers) {
        for (const group of value.groups) {
          lines.push(
            group.members.length === 0
              ? `- ${group.name} (${group.id}): empty`
              : `- ${group.name} (${group.id}): ${group.members.join(', ')}`
          )
        }
      } else if (value.groups.length > 0) {
        lines.push(value.groups.map((group) => `${group.name} (${group.memberCount})`).join(', '))
      }
      return [{ type: 'text', text: lines.join('\n') }]
    }
  },
  async execute(args) {
    const input = args ?? {}
    const action = typeof input.action === 'string' ? input.action.trim() : ''
    if (!ACTIONS.includes(action)) throw new Error(`\`action\` must be one of: ${ACTIONS.join(', ')}`)

    // Work on a copy: `replaceGroups` normalizes and stores, and a half-applied
    // edit must never reach the live array.
    const list = getGroups().map((group) => ({ id: group.id, name: group.name, members: [...group.members] }))
    let message
    let next

    switch (action) {
      case 'list': {
        message =
          list.length === 0
            ? 'There are no tool groups yet.'
            : `${list.length} group${list.length === 1 ? '' : 's'}: ${list.map((group) => group.name).join(', ')}.`
        break
      }
      case 'get': {
        const group = findGroup(list, input.group)
        message =
          group.members.length === 0
            ? `Group "${group.name}" (${group.id}) is empty.`
            : `Group "${group.name}" (${group.id}) holds ${group.members.length} tool${group.members.length === 1 ? '' : 's'}.`
        break
      }
      case 'create': {
        const name = readName(input.name)
        assertNameFree(list, name)
        if (list.length >= MAX_GROUPS) {
          throw new Error(`this profile already holds the maximum of ${MAX_GROUPS} groups; delete one first`)
        }
        const members = readMembers(input.members)
        next = [...list, { name, members }]
        message = `Created group "${name}" with ${members.length} tool${members.length === 1 ? '' : 's'}.`
        break
      }
      case 'rename': {
        const group = findGroup(list, input.group)
        const name = readName(input.name)
        assertNameFree(list, name, group.id)
        next = list.map((entry) => (entry.id === group.id ? { ...entry, name } : entry))
        message = `Renamed group "${group.name}" to "${name}".`
        break
      }
      case 'set_members':
      case 'add_members':
      case 'remove_members': {
        const group = findGroup(list, input.group)
        const members = readMembers(input.members)
        if (members.length === 0 && action !== 'set_members') {
          throw new Error(`\`members\` must name at least one tool for ${action}`)
        }
        let updated
        if (action === 'set_members') {
          updated = members
        } else if (action === 'add_members') {
          updated = [...group.members, ...members.filter((name) => !group.members.includes(name))]
        } else {
          const drop = new Set(members)
          updated = group.members.filter((name) => !drop.has(name))
        }
        if (updated.length > MAX_TOOLS) throw new Error(`a group may hold at most ${MAX_TOOLS} tools`)
        next = list.map((entry) => (entry.id === group.id ? { ...entry, members: updated } : entry))
        const verb =
          action === 'set_members' ? 'Set' : action === 'add_members' ? 'Added' : 'Removed'
        message =
          action === 'remove_members'
            ? `Removed ${members.length} tool${members.length === 1 ? '' : 's'} from "${group.name}"; it now holds ${updated.length}.`
            : `${verb} members of "${group.name}"; it now holds ${updated.length} tool${updated.length === 1 ? '' : 's'}.`
        break
      }
      case 'delete': {
        const group = findGroup(list, input.group)
        next = list.filter((entry) => entry.id !== group.id)
        message = `Deleted group "${group.name}". Its tools are unchanged and still available.`
        break
      }
      /* c8 ignore next -- ACTIONS is checked above */
      default:
        throw new Error(`unsupported action "${action}"`)
    }

    if (next !== undefined && replaceGroups(next) === undefined) {
      // normalizeGroups refuses to fabricate state: report the failure rather than
      // answering "ok" for an edit that was not stored.
      throw new Error('the groups could not be saved: the resulting list is not valid')
    }
    return { ok: true, message, groups: summarize(getGroups()) }
  }
}

/**
 * Services required before `apply` may run. The tool is a registry entry and
 * nothing else, so `tools` is its only edge; the storage it edits lives in
 * `index.js`, which is plain functions and needs no service at all.
 */
export const inject = ['tools']

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(definition), 'tools-panel: manage_tool_groups')
}

export { ACTIONS, MAX_GROUP_NAME, definition }
