// Tool panel — CLIENT half.
//
// ONE composer control, TWO tabs:
//
//   工具 (tools)   — the per-tool kill switch. Lists exactly the tools THIS session
//                    can call (read from the Host registry on every open), each with
//                    its own switch; a disabled tool is hidden from the model and, if
//                    it ever reaches dispatch, refused by a guard. Tools can be
//                    bundled into user-named groups with a bulk switch.
//   插件 (plugins) — the profile's plugin on/off switch, driving the official
//                    `pluginManager` Remote. Package-scoped, matching the product's
//                    own unit.
//
// Why one control instead of two: both answer "what is this session allowed to use",
// and two adjacent dropdowns on the same toolbar made the user check both to find
// out. The trigger is ONE shield, ONE menu, ONE dismissal path; the tabs swap only
// the body, so their separate state (search, selection, notice) survives a tab
// switch instead of being torn down and re-read.
//
// The last tab is remembered in localStorage and restored on open. The default (no
// remembered tab) is 插件, per the user's request.
//
// Why this slot:
//   `conversation.input.right` is a `list` slot declared by the shipped composer bar,
//   so a plain registration appends beside the other controls — no shadowing, no
//   forwarding of a shipped entry, and it is reachable in every session rather than
//   only on the new-session hero screen.
//
// Bundle format (client-modules protocol): a classic script registering a factory
// via `window.__ModuleLoader__.load({ id, factory })`. React is the only import;
// everything else is inline (no JSX, no Harness UI packages). Only `--dsw-*` theme
// tokens are styled against.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-tools-panel',
  factory: (require) => {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    /** The composer cell this control occupies: beside the model selector. */
    const SLOT = 'conversation.input.right'
    /** This entry's id inside that list slot. */
    const ID = 'tools-panel'
    /** The only entry in this slot now that both controls merged. */
    const ORDER = 0
    /** Locale namespace, registered here and handed to the entry as its `t` seat. */
    const NS = 'toolsPanel'
    /** Stylesheet identity, so a reloaded bundle replaces its own tag instead of stacking. */
    const CSS_ID = 'dsh-plugin-tools-panel/ToolsPanel.css'
    /** The host route that owns the tool switch. */
    const ROUTE = '/dsh-plugin-tools-panel/state'
    /** The skills route: list this session's skills, toggle one model invocation. */
    const SKILLS_ROUTE = '/dsh-plugin-tools-panel/skills'
    /** The prompt route: list the assembled system prompt sections, toggle one. */
    const PROMPTS_ROUTE = '/dsh-plugin-tools-panel/prompts'
    /** Header the Host requires on a write, so a cross-origin POST cannot flip the switch. */
    const HEADER = 'x-dsh-plugin-tools-panel'
    /**
     * Wire version this bundle speaks; must equal the host half's `PROTOCOL`.
     *
     * The two halves reload independently — saving this file hot-swaps the browser
     * bundle, while `src/index.js` keeps running whatever code the process mounted
     * with until DSH restarts. A saved edit therefore routinely pairs a NEW client
     * with an OLD host, and without this check that shows up as a switch that flips
     * back on its own.
     */
    const PROTOCOL = 8
    /** Menu geometry: fixed width so the open position can be computed before layout. */
    const MENU_WIDTH = 320
    const MENU_MAX_HEIGHT = 420
    const MENU_GAP = 6
    /** How often the open tool tab re-reads the Host's switch state. */
    const POLL_MS = 2000
    /** Where the pinned plugin names are remembered, as a JSON array of names. */
    const PIN_KEY = 'dsh-plugin-tools-panel/pinned'
    /** Where the last tab is remembered: `'tools'`, `'skills'`, `'prompts'` or `'plugins'`. */
    const TAB_KEY = 'dsh-plugin-tools-panel/tab'
    /** The tab a first-ever open shows. */
    const DEFAULT_TAB = 'plugins'

    // --- copy -------------------------------------------------------------------
    // One dictionary for the whole panel, prefixed by tab where a word could collide
    // ("empty" means a different thing on each side, so they are separate keys).
    const ZH = {
      title: '工具面板',
      tabTools: '工具',
      tabSkills: '技能',
      tabPrompts: '提示词',
      tabPlugins: '插件',
      // ---- skills
      skillsSearch: '搜索技能',
      skillsEmpty: '当前会话没有可用的技能',
      skillsNoMatch: '没有匹配的技能',
      skillsLoading: '正在读取技能…',
      skillsFailed: '读取技能失败：',
      skillsUnavailable: '当前部署没有技能服务，无法在这里管理技能。',
      skillsNoAgent: '会话尚未启动，无法读取技能列表。',
      skillsIncomplete: '技能目录没有读全，列表可能缺少条目。',
      skillsUserOff: '该技能本来就不能手动调用，关闭后完全不可用。',
      skillsWarning: '文件已写入，但技能目录还没刷新；稍后刷新或再试一次。',
      // ---- prompts
      promptsSearch: '搜索提示词段落',
      promptsEmpty: '当前会话没有可管理的提示词段落',
      promptsNoMatch: '没有匹配的段落',
      promptsLoading: '正在读取系统提示词…',
      promptsFailed: '读取提示词失败：',
      promptsUnavailable: '当前部署没有系统提示词服务，无法列出注入段落。',
      promptsNoAgent: '会话尚未启动，无法预览注入段落；已关闭的段落仍会保留。',
      promptsAssembleFailed: '系统提示词装配失败',
      promptsSole: '这是当前唯一的提示词段落，关闭会让提示词为空',
      promptsMissing: '当前装配里没有这一段',
      promptsEmptyText: '（这一段的当前文本为空）',
      promptsGlobal: '全局',
      promptsReset: '全部恢复',
      promptsResetConfirm: '再点一次恢复',
      promptsTruncated: '已截断',
      promptsSaving: '正在应用…',
      promptsWarning: '设置已保存，但本会话没有立即生效；请刷新重试。',
      refresh: '刷新',
      // ---- tools
      search: '搜索工具',
      denyAll: '全部禁用',
      allowAll: '全部启用',
      empty: '没有可用的工具',
      noMatch: '没有匹配的工具',
      loading: '正在读取状态…',
      failed: '读取失败：',
      retry: '重试',
      saveFailed: '开关未保存：',
      staleHost: '宿主端还是旧版本，开关改动不会生效。请重启 DSH。',
      inherited: '继承自主会话',
      newGroup: '建组',
      newGroupTitle: '把勾选的工具建成一组',
      groupName: '分组名称',
      create: '创建',
      cancel: '取消',
      rename: '重命名',
      remove: '删除分组',
      select: '创建分组',
      selectAll: '全选',
      clearSelection: '取消创建',
      selected: '已选 {count} 个',
      emptyGroup: '空分组',
      // ---- plugins
      pluginsTitle: '已安装插件',
      pluginsLoading: '正在读取插件…',
      pluginsEmpty: '这个 profile 没有安装插件。',
      pluginsSearch: '搜索插件',
      pluginsNoMatch: '没有匹配的插件',
      pluginsFailed: '读取失败：',
      pluginsUnavailable: '本部署没有可管理的 profile，无法启停插件。',
      pluginsManagementRequired: '宿主基础设施，不可开关',
      pluginsUnaddressable: '不在 profile 补丁层中，无法开关',
      pluginsNotBundle: '该包未声明插件补丁，不是插件',
      pluginsBroken: '读取包信息失败',
      pluginsOverridden: '{name} 已保存，但被更高优先级的配置覆盖，当前未生效',
      pluginsCancelled: '{name} 的变更已取消',
      pluginsSwitchFailed: '操作失败：',
      pluginsPin: '收藏置顶',
      pluginsUnpin: '取消置顶',
      pluginsClientHint: '带界面的插件需要刷新页面才会显示变化'
    }
    const EN = {
      title: 'Tool panel',
      tabTools: 'Tools',
      tabSkills: 'Skills',
      tabPrompts: 'Prompts',
      tabPlugins: 'Plugins',
      skillsSearch: 'Search skills',
      skillsEmpty: 'This session has no skills',
      skillsNoMatch: 'No matching skills',
      skillsLoading: 'Reading skills…',
      skillsFailed: 'Could not read skills: ',
      skillsUnavailable: 'This deployment has no skills service, so skills cannot be managed here.',
      skillsNoAgent: 'This session is not running, so its skills cannot be read.',
      skillsIncomplete: 'The skill catalog was read incompletely; rows may be missing.',
      skillsUserOff: 'This skill is not user-invocable, so turning it off makes it fully unavailable.',
      skillsWarning: 'The file was written, but the catalog has not refreshed yet; refresh or retry shortly.',
      promptsSearch: 'Search prompt sections',
      promptsEmpty: 'This session has no manageable prompt sections',
      promptsNoMatch: 'No matching sections',
      promptsLoading: 'Reading the system prompt…',
      promptsFailed: 'Could not read the prompt: ',
      promptsUnavailable: 'This deployment has no system prompt service, so injected sections cannot be listed.',
      promptsNoAgent: 'This session is not running, so injected sections cannot be previewed; disabled sections are kept.',
      promptsAssembleFailed: 'The system prompt failed to assemble',
      promptsSole: 'This is the only prompt section; turning it off would leave the prompt empty',
      promptsMissing: 'Not present in the current assembly',
      promptsEmptyText: '(this section is currently empty)',
      promptsGlobal: 'Global',
      promptsReset: 'Restore all',
      promptsResetConfirm: 'Click again to restore',
      promptsTruncated: 'truncated',
      promptsSaving: 'Applying…',
      promptsWarning: 'Saved, but this session did not pick it up; refresh and retry.',
      refresh: 'Refresh',
      search: 'Search tools',
      denyAll: 'Disable all',
      allowAll: 'Enable all',
      empty: 'No tools available',
      noMatch: 'No matching tools',
      loading: 'Reading state…',
      failed: 'Could not read state: ',
      retry: 'Retry',
      saveFailed: 'The switch was not saved: ',
      staleHost: 'The Host half is an older revision, so switch changes cannot take effect. Restart DSH.',
      inherited: 'Inherited from the parent session',
      newGroup: 'Group',
      newGroupTitle: 'Group the selected tools',
      groupName: 'Group name',
      create: 'Create',
      cancel: 'Cancel',
      rename: 'Rename',
      remove: 'Delete group',
      select: 'New group',
      selectAll: 'Select all',
      clearSelection: 'Cancel',
      selected: '{count} selected',
      emptyGroup: 'Empty group',
      pluginsTitle: 'Installed plugins',
      pluginsLoading: 'Reading plugins…',
      pluginsEmpty: 'This profile has no plugins installed.',
      pluginsSearch: 'Search plugins',
      pluginsNoMatch: 'No matching plugins',
      pluginsFailed: 'Could not read plugins: ',
      pluginsUnavailable: 'This deployment has no manageable profile, so plugins cannot be switched.',
      pluginsManagementRequired: 'Host infrastructure — cannot be switched',
      pluginsUnaddressable: 'Not addressable through the profile patch layer',
      pluginsNotBundle: 'This package declares no plugin patch, so it is not a plugin',
      pluginsBroken: 'Could not read the package manifest',
      pluginsOverridden: '{name} saved, but a higher-priority layer still overrides it — not in effect',
      pluginsCancelled: 'The change to {name} was cancelled',
      pluginsSwitchFailed: 'The change failed: ',
      pluginsPin: 'Pin to top',
      pluginsUnpin: 'Unpin',
      pluginsClientHint: 'Plugins with a UI need a page refresh before the change shows'
    }

    /** The copy for the active language, as a plain dictionary. */
    function copyFor(ctx) {
      let language
      try {
        language = ctx.get('locale')?.getSnapshot?.()?.active
      } catch {
        language = undefined
      }
      if (typeof language !== 'string' || language.length === 0) {
        language = typeof navigator !== 'undefined' ? navigator.language : undefined
      }
      return String(language ?? 'en').toLowerCase().startsWith('zh') ? ZH : EN
    }

    /** A translate function over one dictionary: the seat shape, built locally. */
    function translateWith(dict) {
      return (key, params) => {
        const template = dict[key]
        if (typeof template !== 'string') return key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, field) =>
          Object.prototype.hasOwnProperty.call(params, field) ? String(params[field]) : match
        )
      }
    }

    // --- the remembered tab -------------------------------------------------------
    /** The last tab opened, or the default. Storage access is wrapped: a locked-down
     * browser can throw on localStorage itself, and the panel must still open. */
    function readTab() {
      try {
        const raw = window.localStorage.getItem(TAB_KEY)
        return raw === 'tools' || raw === 'skills' || raw === 'prompts' || raw === 'plugins'
          ? raw
          : DEFAULT_TAB
      } catch {
        return DEFAULT_TAB
      }
    }

    function writeTab(tab) {
      try {
        window.localStorage.setItem(TAB_KEY, tab)
      } catch {
        /* the choice still applies to this render tree */
      }
    }

    // --- the tool tab: talking to the host ---------------------------------------
    /** Raised when the Host is running a different revision than this bundle. */
    class StaleHostError extends Error {}

    /**
     * One request to the control route, unwrapped.
     *
     * The route answers a JSON envelope, and a non-2xx is a refusal whose `error`
     * is the only useful thing to show — so both paths funnel into one throw.
     * `cache: 'no-store'` is not decoration: the state is polled, and a cached
     * GET would keep showing a switch the user already flipped.
     *
     * The protocol check is what keeps a host/bundle version skew from masquerading
     * as a broken switch.
     * @returns the answer's full envelope (`{ ok, state, applied? }`).
     */
    async function request(init, url = ROUTE) {
      const response = await fetch(url, { cache: 'no-store', ...init })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`the Host answered ${response.status} without JSON`)
      }
      if (payload?.ok !== true) {
        // A host old enough to predate the protocol field answers the OLD shape
        // rather than refusing, so the mismatch is detected from the successful
        // answer below. A 409 on the STATE route is the other direction of the same
        // skew and carries the restart instruction — but on the skills/prompt routes
        // a 409 is an ordinary refusal (no file, unshadowable section, sole section),
        // and turning those into "restart DSH" would hide the real reason.
        throw response.status === 409 && url === ROUTE
          ? new StaleHostError(payload?.error)
          : new Error(payload?.error ?? `the Host answered ${response.status}`)
      }
      if (payload.state?.protocol !== PROTOCOL) {
        throw new StaleHostError(
          `this page speaks tools-panel protocol ${PROTOCOL} but the Host answered ` +
            `${payload.state?.protocol ?? 'an older revision'}; restart DSH to load the matching host half`
        )
      }
      return payload
    }

    /** One request, reduced to its `state` object (the shape every tab reads). */
    async function call(init, url = ROUTE) {
      return (await request(init, url)).state
    }

    /**
     * Read one session's list.
     *
     * The session is a QUERY PARAMETER, not a body: this is a GET, and the route is
     * per-session. Encoding it keeps a session id from being read as a path or
     * being truncated at a character that means something in a URL.
     */
    const readState = (sessionId) => call({ method: 'GET' }, `${ROUTE}?sessionId=${encodeURIComponent(sessionId)}`)

    /**
     * Replace the denied set; the Host answers the state it now holds.
     *
     * The whole list is written rather than a per-name toggle: the control already
     * knows the set, a whole-list write is idempotent, and two windows racing on one
     * name cannot leave a half-updated list behind.
     */
    const writeDeny = (sessionId, deny) =>
      call({
        method: 'POST',
        headers: { 'content-type': 'application/json', [HEADER]: '1' },
        body: JSON.stringify({ sessionId, deny })
      })

    /**
     * Save the group definitions.
     *
     * Groups are global (the Host writes one file for the whole profile), but the
     * request still carries the session so the answer is that conversation's
     * snapshot — the same shape every other call returns.
     */
    const writeGroups = (sessionId, groups) =>
      call({
        method: 'POST',
        headers: { 'content-type': 'application/json', [HEADER]: '1' },
        body: JSON.stringify({ sessionId, groups })
      })

    // --- the skills and prompt tabs: talking to the Host --------------------------
    const readSkills = (sessionId) =>
      call({ method: 'GET' }, `${SKILLS_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`)

    /** One skill's model visibility; the answer also says whether it took effect. */
    const writeSkill = async (sessionId, name, enabled) => {
      const answer = await request({
        method: 'POST',
        headers: { 'content-type': 'application/json', [HEADER]: '1' },
        body: JSON.stringify({ sessionId, name, enabled })
      }, SKILLS_ROUTE)
      return { state: answer.state, applied: answer.applied !== false }
    }

    const readPrompts = (sessionId) =>
      call({ method: 'GET' }, `${PROMPTS_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`)

    /** One assembled section off/on; the Host verifies and rolls back on a refusal. */
    const writePrompt = async (sessionId, name, enabled) => {
      const answer = await request({
        method: 'POST',
        headers: { 'content-type': 'application/json', [HEADER]: '1' },
        body: JSON.stringify({ sessionId, name, enabled })
      }, PROMPTS_ROUTE)
      return { state: answer.state, applied: answer.applied !== false }
    }

    const resetPrompts = (sessionId) =>
      call({
        method: 'POST',
        headers: { 'content-type': 'application/json', [HEADER]: '1' },
        body: JSON.stringify({ sessionId, reset: true })
      }, PROMPTS_ROUTE)

    // --- the plugin tab: pins and the manager -------------------------------------
    // --- the pinned set -----------------------------------------------------------
    // Pins are the user's own ranking, so they outlive the menu and the session:
    // they are remembered per package name. Storage access is wrapped because a
    // locked-down browser profile can throw on localStorage itself, and the
    // stored value is unvalidated JSON — a hand-edited or half-written entry must
    // degrade to "nothing pinned" rather than take the menu down with it.
    function readPinned() {
      try {
        const raw = window.localStorage.getItem(PIN_KEY)
        if (typeof raw !== 'string') return new Set()
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return new Set()
        return new Set(parsed.filter((name) => typeof name === 'string'))
      } catch {
        return new Set()
      }
    }

    function writePinned(pinned) {
      try {
        window.localStorage.setItem(PIN_KEY, JSON.stringify([...pinned]))
      } catch {
        /* the choice still applies to this render tree */
      }
    }

    // --- reading the manager ------------------------------------------------------
    /**
     * Reach the Host's plugin Remote namespaces.
     *
     * Probed, not injected: a deployment that mounts no plugin manager (a
     * terminal-only profile, or a Host built without the boot plugin) must lose
     * only the list, never the composer control — an `inject` edge on a service
     * that never appears would hold this plugin inactive forever, and the control
     * would silently not exist. (`ctx.get('remote.pluginManager')` is the
     * namespace service; `ctx.get('remote')?.pluginManager` is the second
     * spelling of the same thing.)
     * @returns `{ manager, inventory }`, either half possibly undefined.
     */
    function pluginRemote(ctx) {
      const reads = [() => ctx.get('remote'), () => ctx.get('remote.pluginManager')]
      for (const read of reads) {
        try {
          const remote = read()
          if (remote === null || remote === undefined) continue
          const manager = remote.pluginManager ?? remote
          if (typeof manager?.listBundles === 'function') {
            return { manager, inventory: remote.pluginInventory }
          }
        } catch {
          /* no such service in this profile */
        }
      }
      return { manager: undefined, inventory: undefined }
    }

    /**
     * Unwrap one Remote answer.
     *
     * Remote calls answer with an envelope instead of throwing, and the shipped
     * callers treat a non-`ok` answer as a failure — `pluginManager` refusals carry
     * a machine code plus a human diagnostic, and the diagnostic is what the user
     * needs to read.
     * @returns the answer's value.
     */
    function unwrap(answer, subject) {
      if (answer === null || answer === undefined || answer.ok !== true) {
        const detail = answer?.error?.diagnostic ?? answer?.error?.message ?? answer?.error?.code
        throw new Error(detail === undefined ? `${subject} was refused` : `${subject}: ${detail}`)
      }
      return answer.value
    }

    // --- shaping the rows ---------------------------------------------------------
    /**
     * A display string from a `meta` field that may be plain or localized.
     *
     * The manifest reader hands back either a string or a locale map, and the
     * shipped surfaces resolve the map through the locale service. Reading `zh`
     * the same way it reads `en` keeps a Chinese manifest's title intact instead
     * of dropping it to the package name.
     */
    function displayText(value, language) {
      if (typeof value === 'string' && value.length > 0) return value
      if (value === null || typeof value !== 'object') return undefined
      const preferred = language?.startsWith('zh') ? value.zh : value.en
      for (const candidate of [preferred, value.en, value.zh]) {
        if (typeof candidate === 'string' && candidate.length > 0) return candidate
      }
      return undefined
    }

    /**
     * Whether a bundle row names a plugin the user may switch.
     *
     * Two rows must be dropped, for opposite reasons:
     *
     *   - **Not installed.** `listBundles` names three sources: the profile's
     *     selected bundles, its own dependencies, and everything the dsh
     *     installation ships — which includes the OTHER shipped runtimes
     *     (`dsh-acp-app`, `dsh-headless`, `dsh-sdk-app`). Those are alternative
     *     host shells, not desktop plugins: composing one into the desktop
     *     profile mounts a patch layer that fights the running web app for the
     *     same required slots, and the profile then fails to boot.
     *     `installed` is "a dependency of THIS profile's manifest", which is
     *     exactly the line between a plugin the user put here and an alternative
     *     runtime the installation merely offers.
     *
     *   - **`not-bundle`.** An ordinary library dependency (no `dsh.bundle` in
     *     its manifest) arrives as a `not-bundle` error row. That is a true
     *     report about a package that is not a plugin, and showing it would
     *     offer a switch that can never work — so it is kept only while it is
     *     actually selected, where it means "this profile's bundle list names
     *     something that is not a plugin" and is worth seeing.
     */
    function isSwitchableRow(row) {
      if (row?.installed !== true) return false
      if (row?.error === undefined) return true
      if (row.error.code === 'not-bundle') return row.enabled === true
      return true
    }

    /**
     * Why a row cannot be switched, or undefined when it can.
     *
     * `readOnlyReason` is the manager's own verdict and outranks anything derived
     * here: `management-required` marks the infrastructure whose removal would
     * break the running process, and `unaddressable` marks a row no profile patch
     * can name. An `error` row is refused for the same reason it errored.
     * @param t - the translate function for the active dictionary.
     */
    function rowRefusal(row, t) {
      if (row.readOnlyReason === 'management-required') return t('pluginsManagementRequired')
      if (row.readOnlyReason === 'unaddressable') return t('pluginsUnaddressable')
      if (row.error === undefined) return undefined
      if (row.error.code === 'not-bundle') return t('pluginsNotBundle')
      return row.error.diagnostic ?? row.error.code
    }

    /**
     * Sort rows: pinned first, then enabled, then by display name.
     *
     * A pin outranks the enabled grouping on purpose. The pin is the user's own
     * ranking and the enabled/unenabled split is the manager's state, so letting
     * state win would let a switch flip silently move a row the user had put where
     * they wanted it — the one thing a pin promises not to do. That is also why
     * the pin is independent of the switch: pinning an enabled plugin and pinning
     * a disabled one both put it at the top.
     */
    function sortRows(rows) {
      return [...rows].sort((left, right) => {
        const leftPinned = left.pinned === true
        const rightPinned = right.pinned === true
        if (leftPinned !== rightPinned) return leftPinned ? -1 : 1
        if (left.enabled !== right.enabled) return left.enabled ? -1 : 1
        return (left.title ?? left.name).localeCompare(right.title ?? right.name)
      })
    }

    /**
     * Fetch the profile's plugins as render rows.
     *
     * The inventory snapshot is read first because it, not the manager, answers
     * whether this deployment manages a profile at all — the manager exists in
     * every Host, but only a profile-backed one can write a switch, and asking it
     * anyway would surface a refusal where the honest answer is "not available
     * here".
     * @returns `{ rows }` or `{ unavailable: true }`.
     */
    async function readPlugins(ctx, language) {
      const { manager, inventory } = pluginRemote(ctx)
      if (manager === undefined) throw new Error('the Host exposes no plugin manager')
      if (inventory !== undefined && typeof inventory.list === 'function') {
        const snapshot = unwrap(await inventory.list(), 'pluginInventory.list')
        if (snapshot?.managementAvailable !== true) return { unavailable: true }
      }
      const bundles = unwrap(await manager.listBundles(), 'pluginManager.listBundles')
      if (!Array.isArray(bundles)) throw new Error('pluginManager.listBundles answered no list')
      // Read the dictionary once for the whole pass: `copyFor` probes the locale
      // service, and a per-row probe would repeat that for every installed package.
      // `translateWith` adapts it to the seat shape the component uses.
      const t = translateWith(copyFor(ctx))
      const pinned = readPinned()
      const rows = bundles.filter(isSwitchableRow).map((row) => {
        const title = displayText(row.meta?.title, language) ?? row.name
        return {
          name: row.name,
          title,
          // The package identity stays visible: two plugins can share a display
          // title, and this is the string a bug report needs.
          version: typeof row.version === 'string' ? row.version : undefined,
          installed: row.installed === true,
          enabled: row.enabled === true,
          pinned: pinned.has(row.name),
          refusal: rowRefusal(row, t)
        }
      })
      return { rows: sortRows(rows) }
    }

    const CSS = `
.dsh-tools-panel-tool-root { position: relative; display: inline-flex; min-width: 0; }
.dsh-tools-panel-tool-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
  cursor: pointer;
}
.dsh-tools-panel-tool-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-tools-panel-tool-trigger:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
/* The trigger carries the state, not just the label: a switch the user forgot they
   flipped must be visible without opening the menu. Colour plus the icon's fill is
   the signal; no text changes width, so the bar does not reflow on a flip. */
.dsh-tools-panel-tool-triggerActive { color: var(--dsw-alias-state-warn-primary, var(--dsw-alias-brand-primary)); }
.dsh-tools-panel-tool-chevron { flex: none; color: var(--dsw-alias-label-caption); transition: transform .12s; }
.dsh-tools-panel-tool-chevronOpen { transform: rotate(180deg); }
.dsh-tools-panel-tool-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 2px;
}
.dsh-tools-panel-tool-inherited { color: var(--dsw-alias-state-warn-primary, var(--dsw-alias-brand-primary)); font-size: 11px; line-height: 16px; }
.dsh-tools-panel-tool-search {
  box-sizing: border-box;
  margin: 2px 4px 4px;
  padding: 4px 8px;
  border: .5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  outline: none;
}
.dsh-tools-panel-tool-search::placeholder { color: var(--dsw-alias-label-tertiary); }
.dsh-tools-panel-tool-search:focus-visible { border-color: var(--dsw-alias-brand-primary); }
/* The list scrolls INSIDE the menu: the tool set is unbounded (several MCP servers
   is a hundred-plus names), and a menu taller than the viewport would push its own
   search field off screen. */
.dsh-tools-panel-tool-list {
  display: flex;
  flex-direction: column;
  /* Fills whatever the menu has left after the header rows, and scrolls inside it.
     No viewport-unit cap: the menu's own max-height already bounds this, and a
     second, independent cap made the list stop short of the visible area. */
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.dsh-tools-panel-tool-row {
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  width: 100%;
  min-height: 26px;
  padding: 2px 8px;
  border-radius: var(--dsw-radius-md);
}
.dsh-tools-panel-tool-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
/* One line per tool: the name only. Long MCP names ellipsize instead of wrapping,
   so the rows stay on a fixed rhythm; the full name is in the tooltip. */
.dsh-tools-panel-tool-name {
  min-width: 0;
  margin-inline-end: auto;
  overflow: hidden;
  font-size: 12px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-tools-panel-tool-rowOff .dsh-tools-panel-tool-name { color: var(--dsw-alias-label-tertiary); text-decoration: line-through; }
.dsh-tools-panel-tool-bulk {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 4px 2px;
}
.dsh-tools-panel-tool-bulkButton {
  flex: 1;
  padding: 3px 8px;
  border: .5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.dsh-tools-panel-tool-bulkButton:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-tools-panel-tool-bulkButton:disabled { cursor: default; opacity: .45; }
/* The capsule track and circular thumb, drawn rather than imported: the shape is
   the product's own switch, and keying the fill off aria-checked is what keeps the
   picture from disagreeing with the state assistive technology reads. */
.dsh-tools-panel-tool-switch {
  position: relative;
  box-sizing: border-box;
  flex: 0 0 auto;
  width: 30px;
  height: 17px;
  padding: 2px;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-border-l3);
  cursor: pointer;
  transition: background-color .12s ease;
}
.dsh-tools-panel-tool-switch[aria-checked='true'] { background: var(--dsw-alias-state-warn-primary, var(--dsw-alias-brand-primary)); }
.dsh-tools-panel-tool-switch:disabled { cursor: default; opacity: .45; }
.dsh-tools-panel-tool-switch:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.dsh-tools-panel-tool-thumb {
  display: block;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--dsw-alias-switch-thumb);
  transition: transform .12s ease, background-color .12s ease;
}
.dsh-tools-panel-tool-switch[aria-checked='true'] .dsh-tools-panel-tool-thumb {
  background: var(--dsw-alias-label-primary-foreground);
  transform: translateX(13px);
}
.dsh-tools-panel-tool-group {
  display: flex;
  flex-direction: column;
}
.dsh-tools-panel-tool-groupHead {
  display: flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  width: 100%;
  min-height: 24px;
  padding: 2px 8px;
  border-radius: var(--dsw-radius-md);
}
.dsh-tools-panel-tool-groupHead:hover { background: var(--dsw-alias-interactive-bg-hover); }
/* The disclosure caret: groups are collapsible, and a group starts collapsed only
   when it has enough members that its rows would bury the rest of the list. */
.dsh-tools-panel-tool-groupCaret {
  flex: none;
  width: 10px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-caption);
  font: inherit;
  font-size: 10px;
  line-height: 12px;
  cursor: pointer;
  transition: transform .12s;
}
.dsh-tools-panel-tool-groupCaretOpen { transform: rotate(90deg); }
.dsh-tools-panel-tool-groupName {
  min-width: 0;
  margin-inline-end: auto;
  overflow: hidden;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-tools-panel-tool-groupMeta { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
/* Members are indented once, so a group reads as a container rather than a peer of
   the tools it holds. */
.dsh-tools-panel-tool-groupMembers { display: flex; flex-direction: column; padding-inline-start: 14px; }
/* Selection mode dims the switches: while choosing members the switches are not
   what a click on the row means, and an active-looking switch next to a checkbox
   invites the wrong gesture. */
.dsh-tools-panel-tool-selectBar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 4px 2px;
}
.dsh-tools-panel-tool-selectBar .dsh-tools-panel-tool-bulkButton { flex: 0 0 auto; }
.dsh-tools-panel-tool-selectCount { margin-inline-start: auto; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.dsh-tools-panel-tool-check {
  flex: none;
  box-sizing: border-box;
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--dsw-alias-brand-primary);
  cursor: pointer;
}
.dsh-tools-panel-tool-createRow { display: flex; align-items: center; gap: 6px; padding: 4px 4px 2px; }
.dsh-tools-panel-tool-createInput {
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  padding: 3px 8px;
  border: .5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  outline: none;
}
.dsh-tools-panel-tool-createInput:focus-visible { border-color: var(--dsw-alias-brand-primary); }
.dsh-tools-panel-tool-status { padding: 6px 8px; }
.dsh-tools-panel-tool-note { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.dsh-tools-panel-tool-hint { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.dsh-tools-panel-tool-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 17px; }
.dsh-tools-panel-tool-retry {
  align-self: flex-start;
  margin: 4px 8px 6px;
  padding: 3px 10px;
  border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.dsh-tools-panel-tool-retry:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-tools-panel-plugin-root { position: relative; display: inline-flex; min-width: 0; }
.dsh-tools-panel-plugin-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  max-width: 180px;
  padding: 0 4px 0 8px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
  cursor: pointer;
}
.dsh-tools-panel-plugin-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-tools-panel-plugin-trigger:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.dsh-tools-panel-plugin-triggerIcon { display: inline-flex; flex: none; }
.dsh-tools-panel-plugin-triggerLabel { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tools-panel-plugin-chevron { flex: none; color: var(--dsw-alias-label-caption); transition: transform .12s; }
.dsh-tools-panel-plugin-chevronOpen { transform: rotate(180deg); }
.dsh-tools-panel-plugin-header { padding: 6px 8px 4px; }
.dsh-tools-panel-plugin-title { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; line-height: 18px; }
.dsh-tools-panel-plugin-sub { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.dsh-tools-panel-plugin-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.dsh-tools-panel-plugin-row {
  display: flex;
  align-items: center;
  gap: 10px;
  box-sizing: border-box;
  width: 100%;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-md);
}
.dsh-tools-panel-plugin-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-tools-panel-plugin-meta { display: flex; flex-direction: column; min-width: 0; margin-inline-end: auto; }
.dsh-tools-panel-plugin-name { overflow: hidden; font-size: 13px; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tools-panel-plugin-nameOff { color: var(--dsw-alias-label-secondary); }
.dsh-tools-panel-plugin-identity {
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  line-height: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-tools-panel-plugin-refusal { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 15px; }
/* A pinned row keeps a faint tint even when the pointer is elsewhere, so "why is
   this at the top" is answerable without hovering. Colour is the secondary cue:
   the filled star and aria-pressed carry the same fact. */
.dsh-tools-panel-plugin-rowPinned { background: var(--dsw-alias-interactive-bg-hover); }
/* The pin is a plain button beside the switch: quiet until the row is hovered or
   the pin is on, so a list of them does not read as a row of controls. Only the
   pin's own colour changes with the pointer — the switch stays fully weighted,
   because it is the action and this is an ordering preference. */
.dsh-tools-panel-plugin-pin {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  opacity: 0;
  transition: opacity .12s ease, color .12s ease;
}
.dsh-tools-panel-plugin-row:hover .dsh-tools-panel-plugin-pin,
.dsh-tools-panel-plugin-pin:focus-visible { opacity: 1; }
.dsh-tools-panel-plugin-pinOn {
  color: var(--dsw-alias-state-warn-primary, var(--dsw-alias-brand-primary));
  opacity: 1;
}
.dsh-tools-panel-plugin-pin:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-tools-panel-plugin-pin:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
/* The capsule track and circular thumb, drawn rather than imported: the shape is
   the product's own switch, and keying the fill off aria-checked is what keeps the
   picture from disagreeing with the state assistive technology reads. */
.dsh-tools-panel-plugin-switch {
  position: relative;
  box-sizing: border-box;
  flex: 0 0 auto;
  width: 36px;
  height: 20px;
  padding: 2px;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-border-l3);
  cursor: pointer;
  transition: background-color .12s ease;
}
.dsh-tools-panel-plugin-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.dsh-tools-panel-plugin-switch:disabled { cursor: default; opacity: .45; }
.dsh-tools-panel-plugin-switch:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.dsh-tools-panel-plugin-thumb {
  display: block;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-switch-thumb);
  transition: transform .12s ease, background-color .12s ease;
}
.dsh-tools-panel-plugin-switch[aria-checked='true'] .dsh-tools-panel-plugin-thumb {
  background: var(--dsw-alias-label-primary-foreground);
  transform: translateX(16px);
}
.dsh-tools-panel-plugin-status { padding: 6px 8px; }
.dsh-tools-panel-plugin-note { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 17px; }
.dsh-tools-panel-plugin-warn { color: var(--dsw-alias-state-warn-label); font-size: 12px; line-height: 17px; }
.dsh-tools-panel-plugin-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 17px; }
.dsh-tools-panel-plugin-retry {
  align-self: flex-start;
  margin: 4px 8px 6px;
  padding: 3px 10px;
  border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.dsh-tools-panel-plugin-retry:hover { background: var(--dsw-alias-interactive-bg-hover); }
/* The panel shell: one trigger, one menu, a tab strip, and a body the active tab owns. */
.dsh-tools-panel-root { position: relative; display: inline-flex; min-width: 0; }
.dsh-tools-panel-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
  cursor: pointer;
}
.dsh-tools-panel-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-tools-panel-trigger:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
/* The menu is the ONLY height authority: its max-height comes from the trigger's
   position (inline style), and everything inside is a flex item that shrinks instead
   of overflowing. Getting this backwards is what made the plugin tab unscrollable —
   the list had overflow-y: auto but no height constraint, so it simply grew and the
   menu's overflow: hidden cut it off. */
.dsh-tools-panel-menu {
  position: fixed;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 320px;
  max-width: calc(100vw - 24px);
  border: .5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
}
/* Four equal tabs across the top: a segmented control, not a list of links, because
   these views are peers of one panel rather than navigation. */
.dsh-tools-panel-tabs {
  display: flex;
  gap: 2px;
  padding: 4px;
  border-bottom: .5px solid var(--dsw-alias-border-l1);
}
.dsh-tools-panel-tab {
  flex: 1;
  padding: 4px 8px;
  border: 0;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.dsh-tools-panel-tab:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-tools-panel-tabActive { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-weight: 500; }
.dsh-tools-panel-tab:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
/* The body scrolls as a whole, so each tab's own list keeps its own inner scroll
   only when it needs one; the menu's fixed max-height is what stops it growing past
   the composer. */
/* flex:1 1 auto + min-height:0 is the pair that lets the body shrink below its
   content's natural height; without min-height:0 a flex child refuses to shrink and
   the overflow lands back on the clipped menu. */
.dsh-tools-panel-body { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow: hidden; }
/* The per-tab wrapper. It exists only to hold the inactive tab's display:none, and
   that is exactly why it must also be a flex participant: an unstyled wrapper in the
   middle of the chain breaks flex:1 on everything below it, and the list below then
   has no height to scroll in. The inline display:none for the hidden tab still wins
   over this rule, which is the one place inline style is correct. */
.dsh-tools-panel-pane {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
/* A tab body is a column of [fixed rows…] + [one scrolling list]. Only the list gets
   overflow-y:auto; the tab body itself never scrolls, so the search field and the
   action bar stay put while the rows move under them. */
.dsh-tools-panel-tabBody {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  padding: 4px;
}
/* Skills: the tool row with a second, quieter line. The switch stays top-aligned so
   a two-line description cannot pull it away from the name it belongs to. */
.dsh-tools-panel-skill-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  box-sizing: border-box;
  width: 100%;
  padding: 5px 8px;
  border-radius: var(--dsw-radius-md);
}
.dsh-tools-panel-skill-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-tools-panel-skill-meta { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.dsh-tools-panel-skill-desc {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 15px;
  word-break: break-word;
}
.dsh-tools-panel-skill-rowOff .dsh-tools-panel-tool-name { color: var(--dsw-alias-label-secondary); }
.dsh-tools-panel-skill-badge {
  color: var(--dsw-alias-label-caption);
  font-family: var(--ds-font-family-code);
  font-size: 10px;
  line-height: 14px;
}
/* Prompts: one column per section. The head is the switch row; the preview is a
   second line and doubles as the disclosure target, so a long section does not
   need its own button. */
.dsh-tools-panel-prompt-row {
  display: flex;
  flex-direction: column;
  gap: 1px;
  box-sizing: border-box;
  width: 100%;
  padding: 5px 8px;
  border-radius: var(--dsw-radius-md);
}
.dsh-tools-panel-prompt-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-tools-panel-prompt-rowOff .dsh-tools-panel-prompt-name { color: var(--dsw-alias-label-secondary); }
.dsh-tools-panel-prompt-rowMissing { opacity: .6; }
.dsh-tools-panel-prompt-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-tools-panel-prompt-name {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  line-height: 16px;
  text-align: start;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.dsh-tools-panel-prompt-name:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.dsh-tools-panel-prompt-global {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-caption);
  font-size: 10px;
  line-height: 14px;
}
.dsh-tools-panel-prompt-preview {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 15px;
  word-break: break-word;
  cursor: pointer;
}
.dsh-tools-panel-prompt-text {
  max-height: 160px;
  margin: 2px 0 0;
  padding: 6px;
  overflow: auto;
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  line-height: 16px;
  white-space: pre-wrap;
  word-break: break-word;
}
.dsh-tools-panel-prompt-note { color: var(--dsw-alias-label-caption); font-size: 10px; line-height: 14px; }
.dsh-tools-panel-inlineWarn { color: var(--dsw-alias-state-warn-label); font-size: 11px; line-height: 16px; }
.dsh-tools-panel-actions { display: flex; align-items: center; gap: 6px; padding: 4px 8px 2px; }
`

    // --- icons ------------------------------------------------------------------
    /**
     * The shield mark, filled while anything is switched off.
     *
     * One path serves both states: `fill` is the switch, so the icon cannot drift
     * from the colour the trigger already carries.
     */
    function ShieldIcon({ active }) {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', {
          d: 'M8 1.6 13 3.4v4.3c0 3.2-2.1 5.6-5 6.7-2.9-1.1-5-3.5-5-6.7V3.4L8 1.6Z',
          fill: active ? 'currentColor' : 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round'
        })
      )
    }

    /** The shipped chips' disclosure caret. */
    function ChevronIcon({ open }) {
      return h(
        'svg',
        {
          className: open
            ? 'dsh-tools-panel-tool-chevron dsh-tools-panel-tool-chevronOpen'
            : 'dsh-tools-panel-tool-chevron',
          width: 12,
          height: 12,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true'
        },
        h('path', {
          d: 'M4 6.5 8 10.5l4-4',
          stroke: 'currentColor',
          'stroke-width': 1.3,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round'
        })
      )
    }

    /** A plug facing a socket: the package-level plugin mark. */
    function PluginIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M5.5 1.5v2M10.5 1.5v2M3 3.5h10v3.2a5 5 0 0 1-5 5 5 5 0 0 1-5-5V3.5ZM8 11.7v2.8',
          stroke: 'currentColor',
          'stroke-width': 1.2,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round'
        })
      )
    }

    /** The shipped chips' disclosure caret. */
    function ChevronIcon({ open }) {
      return h(
        'svg',
        {
          className: open
            ? 'dsh-tools-panel-plugin-chevron dsh-tools-panel-plugin-chevronOpen'
            : 'dsh-tools-panel-plugin-chevron',
          width: 12,
          height: 12,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true'
        },
        h('path', {
          d: 'M4 6.5 8 10.5l4-4',
          stroke: 'currentColor',
          'stroke-width': 1.3,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round'
        })
      )
    }

    // --- components -------------------------------------------------------------
    /**
     * The pin mark: a filled star when pinned, an outline when not.
     *
     * Drawn as inline SVG rather than a glyph so it inherits `currentColor` from
     * the button and needs no font the page may not have. `fill` follows the same
     * switch, so one path serves both states.
     */
    function PinIcon({ pinned }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: '14',
          height: '14',
          'aria-hidden': 'true',
          focusable: 'false'
        },
        h('path', {
          d: 'M8 1.6l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.4l-3.8 2 .7-4.3-3.1-3 4.3-.6z',
          fill: pinned ? 'currentColor' : 'none',
          stroke: 'currentColor',
          strokeWidth: '1.3',
          strokeLinejoin: 'round'
        })
      )
    }

    // --- rows ------------------------------------------------------------------
    /**
     * One tool: its name and its switch.
     *
     * The switch is a real `button[role=switch]` rather than a checkbox so the
     * Space/Enter activation and the announced state come from the platform. It is
     * disabled only while a write is in flight, never because of the state itself:
     * turning a switch back on must always be possible, even if the read that
     * produced the menu is stale.
     */
    function ToolRow({ name, allowed, busy, selecting, selected, onToggle, onSelect }) {
      const classes = ['dsh-tools-panel-tool-row']
      if (!allowed) classes.push('dsh-tools-panel-tool-rowOff')
      return h(
        'div',
        { className: classes.join(' ') },
        // In selection mode the row's control is a checkbox and the switch is gone:
        // one target per row, so a click can only mean one thing.
        selecting
          ? h('input', {
              type: 'checkbox',
              className: 'dsh-tools-panel-tool-check',
              checked: selected,
              disabled: busy,
              'aria-label': name,
              onChange: onSelect
            })
          : null,
        h('span', { className: 'dsh-tools-panel-tool-name', title: name }, name),
        selecting
          ? null
          : h(
              'button',
              {
                type: 'button',
                role: 'switch',
                className: 'dsh-tools-panel-tool-switch',
                'aria-checked': allowed,
                'aria-label': name,
                disabled: busy,
                onClick: onToggle
              },
              h('span', { className: 'dsh-tools-panel-tool-thumb', 'aria-hidden': 'true' })
            )
      )
    }

    /**
     * One user-defined group: a disclosure head, a bulk switch, and its member rows.
     *
     * The group's own switch is DERIVED, not stored: it reads "on" only when every
     * member is on, and flipping it denies or allows all members. That is the whole
     * semantics of a group here — it has no policy of its own, so there is nothing
     * that could disagree with the tools it holds.
     *
     * A member row is drawn only for a tool that some session can actually call;
     * a member whose tool is gone stays in the definition (it may come back when an
     * MCP server reconnects) but is not drawn, because there is no switch to offer
     * for something that does not exist here.
     */
    function GroupRow({ group, allowedOf, busy, open, onToggleOpen, onToggleAll, onRename, onRemove, children }) {
      const members = group.members
      const on = members.length > 0 && members.every((name) => allowedOf(name))
      return h(
        'div',
        { className: 'dsh-tools-panel-tool-group' },
        h(
          'div',
          { className: 'dsh-tools-panel-tool-groupHead' },
          h(
            'button',
            {
              type: 'button',
              className: open
                ? 'dsh-tools-panel-tool-groupCaret dsh-tools-panel-tool-groupCaretOpen'
                : 'dsh-tools-panel-tool-groupCaret',
              'aria-expanded': open,
              'aria-label': group.name,
              onClick: onToggleOpen
            },
            '\u25B6'
          ),
          h('span', { className: 'dsh-tools-panel-tool-groupName', title: group.name }, group.name),
          h('span', { className: 'dsh-tools-panel-tool-groupMeta' }, String(members.length)),
          h(
            'button',
            {
              type: 'button',
              role: 'switch',
              className: 'dsh-tools-panel-tool-switch',
              'aria-checked': on,
              'aria-label': group.name,
              disabled: busy || members.length === 0,
              onClick: onToggleAll
            },
            h('span', { className: 'dsh-tools-panel-tool-thumb', 'aria-hidden': 'true' })
          )
        ),
        open
          ? h(
              'div',
              { className: 'dsh-tools-panel-tool-groupMembers' },
              members.length === 0
                ? h('div', { className: 'dsh-tools-panel-tool-status' }, h('span', { className: 'dsh-tools-panel-tool-note' }, children?.empty))
                : children?.rows,
              h(
                'div',
                { className: 'dsh-tools-panel-tool-selectBar' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-tools-panel-tool-bulkButton',
                    onClick: onRename
                  },
                  children?.renameLabel
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-tools-panel-tool-bulkButton',
                    onClick: onRemove
                  },
                  children?.removeLabel
                )
              )
            )
          : null
      )
    }

    function PluginRow({ row, busy, onToggle, onPin, t }) {
      const refusal = row.refusal
      const disabled = busy || refusal !== undefined
      const pinned = row.pinned === true
      return h(
        'div',
        {
          className: pinned
            ? 'dsh-tools-panel-plugin-row dsh-tools-panel-plugin-rowPinned'
            : 'dsh-tools-panel-plugin-row'
        },
        h(
          'div',
          { className: 'dsh-tools-panel-plugin-meta' },
          h(
            'span',
            {
              className: row.enabled
                ? 'dsh-tools-panel-plugin-name'
                : 'dsh-tools-panel-plugin-name dsh-tools-panel-plugin-nameOff',
              title: row.name
            },
            row.title
          ),
          h(
            'span',
            { className: 'dsh-tools-panel-plugin-identity', title: row.name },
            row.version === undefined ? row.name : `${row.name} · v${row.version}`
          ),
          refusal === undefined
            ? null
            : h('span', { className: 'dsh-tools-panel-plugin-refusal' }, refusal)
        ),
        h(
          'button',
          {
            type: 'button',
            className: pinned
              ? 'dsh-tools-panel-plugin-pin dsh-tools-panel-plugin-pinOn'
              : 'dsh-tools-panel-plugin-pin',
            'aria-pressed': pinned,
            'aria-label': t(pinned ? 'unpin' : 'pin'),
            title: t(pinned ? 'unpin' : 'pin'),
            onClick: () => onPin(row)
          },
          h(PinIcon, { pinned })
        ),
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            className: 'dsh-tools-panel-plugin-switch',
            'aria-checked': row.enabled,
            'aria-label': row.title,
            disabled,
            onClick: () => onToggle(row)
          },
          h('span', { className: 'dsh-tools-panel-plugin-thumb', 'aria-hidden': 'true' })
        )
      )
    }

    // --- tabs ------------------------------------------------------------------
    function makeToolsTab(ctx) {
      return function ToolsTab({ t: seat, sessionId, active }) {
        // Two seats reach this prop, and both must work. With a locale face installed
        // the renderer supplies `t(key, params)`; without one, `inject` below supplies
        // the dictionary itself. Normalizing here keeps a single `t(key, params)` shape
        // everywhere in the component instead of a `typeof` check at every label.
        const t = typeof seat === 'function' ? seat : translateWith(seat ?? copyFor(ctx))
        // The slot's own `sessionId` seat names the conversation this control sits in.
        // Every request carries it, so the Host edits precisely that session's policy
        // instead of a process-wide one. Guarded rather than assumed: a render without
        // it must not turn into a request for session "undefined", which the Host would
        // rightly refuse — it degrades to a stated error instead.
        const activeSession = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
        // undefined until the first read answers, so the menu can show the loading
        // line rather than rendering every switch as off.
        const [data, setData] = useState(undefined)
        const [status, setStatus] = useState(undefined)
        const [error, setError] = useState(undefined)
        // Set only for a host/bundle protocol mismatch; the menu shows the restart
        // notice instead of the switches, because nothing here can fix it.
        const [stale, setStale] = useState(undefined)
        // Set while a write is in flight, so every switch goes busy together: the
        // write replaces the whole denied set, so a second flip racing it would be
        // computed against a set that is about to change.
        const [pending, setPending] = useState(false)
        // The search filter. Local only: it narrows what is drawn, never the policy.
        const [query, setQuery] = useState('')
        // Selection mode: while on, each row shows a checkbox instead of its switch,
        // and "建组" turns the checked names into a group. Local, like `query`.
        const [selecting, setSelecting] = useState(false)
        const [selected, setSelected] = useState(() => new Set())
        // The group whose name is being typed (or renamed): `{ id?, name }`.
        const [draft, setDraft] = useState(undefined)
        // Which groups are expanded. Collapsed is the default for a big group so one
        // bundle cannot push the rest of the list out of view.
        const [expanded, setExpanded] = useState(() => new Set())
        // Whether the component is still mounted, so a poll that lands after close
        // does not set state on a dead tree.
        const liveRef = useRef(true)
        useEffect(() => {
          liveRef.current = true
          return () => {
            liveRef.current = false
          }
        }, [])

        /** Read the switch, with the loading phase shown only on the first read. */
        // `data` is tracked through a ref rather than a dependency: `load` sets it, so
        // depending on it would give `load` a new identity after every read — and the
        // poll effect below keys off `load`, so the interval would tear down and
        // restart on every tick instead of simply running.
        const dataRef = useRef(undefined)
        const load = useCallback((quiet) => {
          if (activeSession === undefined) {
            setError('this slot carries no session id')
            setStatus('error')
            return
          }
          if (!quiet) setStatus('loading')
          readState(activeSession)
            .then((next) => {
              if (!liveRef.current) return
              dataRef.current = next
              setData(next)
              setError(undefined)
              setStale(undefined)
              setStatus('ready')
            })
            .catch((failure) => {
              if (!liveRef.current) return
              // A version skew is not transient, so it is reported on the first read
              // AND every poll — otherwise a stale host would show its stale switches
              // as if they were simply the truth. Retrying cannot help, so it also
              // drops the switches rather than leaving them operable but inert.
              if (failure instanceof StaleHostError) {
                setStale(String(failure.message))
                setData(undefined)
                setStatus('error')
                return
              }
              // Any other failed poll keeps the switch the user can still operate; only
              // the initial read replaces the menu with the error and its retry.
              if (quiet && dataRef.current !== undefined) return
              setError(String(failure?.message ?? failure))
              setStatus('error')
            })
        }, [activeSession])

        // The panel owns the open/close state now, so this tab loads whenever it
        // becomes the visible one — and never while it is hidden, which is what
        // keeps a hidden tab from polling the Host for a menu nobody is looking at.
        useEffect(() => {
          if (active) load()
        }, [active, load])

        /**
         * Replace the denied set. Optimistic, because the guard is already live in
         * the Host.
         * @param nextDenied - the complete list of names to deny.
         */
        const commit = useCallback(
          (nextDenied) => {
            if (activeSession === undefined) return
            const previous = data?.denied ?? []
            // The switch moves before the answer so the control never feels laggy; a
            // refusal puts it back and says why, rather than leaving a lie on screen.
            setData((prev) => (prev === undefined ? prev : { ...prev, denied: nextDenied }))
            setPending(true)
            writeDeny(activeSession, nextDenied)
              .then((next) => {
                if (!liveRef.current) return
                // Keep the ref the poll's failure path reads in step with the state,
                // or a later failed poll would mistake a loaded menu for an unloaded one.
                dataRef.current = next
                setData(next)
                setError(undefined)
                setStale(undefined)
              })
              .catch((failure) => {
                if (!liveRef.current) return
                setData((prev) => (prev === undefined ? prev : { ...prev, denied: previous }))
                // A stale host is the one failure the user must act on, and it explains
                // the exact symptom they just saw (the switch bouncing back), so it
                // replaces the list instead of sitting under it as a footnote.
                if (failure instanceof StaleHostError) {
                  setStale(String(failure.message))
                  setData(undefined)
                  setStatus('error')
                  return
                }
                setError(`${t('saveFailed')}${String(failure?.message ?? failure)}`)
              })
              .finally(() => {
                if (liveRef.current) setPending(false)
              })
          },
          [activeSession, data, t]
        )

        /**
         * Replace the group definitions. Optimistic like `commit`, and it shares the
         * same `pending` gate: a group write and a deny write target different state
         * but the same menu, and two in-flight optimistic writes would race on the
         * snapshot they both restore from.
         * @param nextGroups - the complete list of `{ id, name, members }`.
         */
        const commitGroups = useCallback(
          (nextGroups) => {
            if (activeSession === undefined) return
            const previous = data?.groups ?? []
            setData((prev) => (prev === undefined ? prev : { ...prev, groups: nextGroups }))
            setPending(true)
            writeGroups(activeSession, nextGroups)
              .then((next) => {
                if (!liveRef.current) return
                dataRef.current = next
                setData(next)
                setError(undefined)
                setStale(undefined)
              })
              .catch((failure) => {
                if (!liveRef.current) return
                setData((prev) => (prev === undefined ? prev : { ...prev, groups: previous }))
                if (failure instanceof StaleHostError) {
                  setStale(String(failure.message))
                  setData(undefined)
                  setStatus('error')
                  return
                }
                setError(`${t('saveFailed')}${String(failure?.message ?? failure)}`)
              })
              .finally(() => {
                if (liveRef.current) setPending(false)
              })
          },
          [activeSession, data, t]
        )

        const denied = useMemo(() => new Set(data?.denied ?? []), [data])
        const tools = data?.tools ?? []
        const groups = data?.groups ?? []
        /** Every name that belongs to at least one group. */
        const grouped = useMemo(() => {
          const set = new Set()
          for (const group of groups) for (const name of group.members) set.add(name)
          return set
        }, [groups])

        /** Switch one tool. `allow` inverts the row's meaning into the deny set. */
        const setAllowed = useCallback(
          (name, allow) => {
            const next = new Set(denied)
            if (allow) next.delete(name)
            else next.add(name)
            commit([...next])
          },
          [commit, denied]
        )

        /** Toggle one member of the current selection (selection mode). */
        const toggleSelected = useCallback((name) => {
          setSelected((prev) => {
            const next = new Set(prev)
            if (next.has(name)) next.delete(name)
            else next.add(name)
            return next
          })
        }, [])

        /** Leave selection mode and drop the marks. */
        const stopSelecting = useCallback(() => {
          setSelecting(false)
          setSelected(new Set())
        }, [])

        /**
         * Deny or allow every member of one group.
         *
         * Derived from the members' current state, not from a stored group flag:
         * "all on" means allow them all, anything else means deny them all, so one
         * click always leaves the group in a single, visible state.
         */
        const flipGroup = useCallback(
          (group) => {
            const next = new Set(denied)
            const allOn = group.members.length > 0 && group.members.every((name) => !next.has(name))
            for (const name of group.members) {
              if (allOn) next.add(name)
              else next.delete(name)
            }
            commit([...next])
          },
          [commit, denied]
        )

        /** Save `draft` as a new group, or rename an existing one. */
        const saveDraft = useCallback(() => {
          const name = (draft?.name ?? '').trim()
          if (name.length === 0) return
          if (draft?.id === undefined) {
            const members = [...selected].filter((tool) => tools.includes(tool))
            if (members.length === 0) return
            commitGroups([...groups, { name, members }])
            stopSelecting()
          } else {
            commitGroups(groups.map((group) => (group.id === draft.id ? { ...group, name } : group)))
          }
          setDraft(undefined)
        }, [commitGroups, draft, groups, selected, stopSelecting, tools])

        /** Drop a group. Its members keep their own switches untouched. */
        const removeGroup = useCallback(
          (id) => {
            commitGroups(groups.filter((group) => group.id !== id))
            setDraft(undefined)
          },
          [commitGroups, groups]
        )

        /** Flip every tool the list currently shows — not the whole registry. */
        const visible = useMemo(() => {
          const needle = query.trim().toLowerCase()
          return needle.length === 0 ? tools : tools.filter((name) => name.toLowerCase().includes(needle))
        }, [tools, query])
        /**
         * The list split into what the menu draws: groups first, then the rest.
         *
         * Ordering rule, and the reason it is not alphabetical: a grouped tool is
         * pulled OUT of the flat list, so each tool appears exactly once and the
         * groups read as containers rather than as filters. The search box applies to
         * both: a group whose name matches is drawn whole, and inside an expanded
         * group the members are filtered too.
         */
        const shownGroups = useMemo(() => {
          const needle = query.trim().toLowerCase()
          return groups
            .map((group) => {
              // Members this session can actually call; a member whose tool is gone
              // stays in the definition but has no row to draw.
              const callable = group.members.filter((name) => tools.includes(name))
              // A group whose NAME matches is drawn whole — searching "git" should
              // show the whole bundle you called "git tools", not the two members
              // that happen to contain the word.
              const direct = needle.length > 0 && group.name.toLowerCase().includes(needle)
              const rows = needle.length === 0 || direct
                ? callable
                : callable.filter((name) => name.toLowerCase().includes(needle))
              return { group, rows, direct }
            })
            .filter((entry) => {
              if (entry.group.members.length === 0) {
                // An empty group survives the filter only when nothing is typed: it
                // is drawn so the user can delete or rename it.
                return query.trim().length === 0
              }
              return entry.rows.length > 0
            })
        }, [groups, query, tools])
        const ungrouped = useMemo(
          () => visible.filter((name) => !grouped.has(name)),
          [visible, grouped]
        )
        const allShownDenied = visible.length > 0 && visible.every((name) => denied.has(name))
        const flipAll = useCallback(() => {
          const next = new Set(denied)
          if (allShownDenied) for (const name of visible) next.delete(name)
          else for (const name of visible) next.add(name)
          commit([...next])
        }, [allShownDenied, commit, denied, visible])

        // Poll only while the menu is open, and never while a write is in flight —
        // a poll that answered an older state would fight the optimistic switch.
        useEffect(() => {
          if (!active) return undefined
          const timer = window.setInterval(() => {
            if (!pending) load(true)
          }, POLL_MS)
          return () => window.clearInterval(timer)
        }, [active, pending, load])

        // ON means ALLOWED. A user reads a switch as "this is enabled", so an on
        // switch permits its tool and turning it off is what disables it.
        // Embedded: the panel supplies the menu shell, the tab bar and the trigger.
        // This tab renders only its own body, so a tab switch never destroys the
        // state above (search text, selection, expanded groups).
        return h(
          'div',
          { className: 'dsh-tools-panel-tabBody', role: 'tabpanel' },
                  // The shell draws the title and the tabs, and the count was removed
                  // at the user's request: the switches already show what is off, so
                  // the number was a second, redundant readout taking a whole row.
                  // Kept here (not deleted) is the inherited notice — that one says
                  // something the switches cannot: whose policy this is.
                  data?.inherited === true
                    ? h(
                        'div',
                        { className: 'dsh-tools-panel-tool-header' },
                        h('span', { className: 'dsh-tools-panel-tool-inherited' }, t('inherited'))
                      )
                    : null,
                  // A protocol mismatch hides the list entirely rather than showing
                  // it as inert. An operable-looking switch that cannot take effect is
                  // exactly the trap this notice exists to end: the user clicks, the
                  // row springs back, and nothing on screen says why.
                  stale !== undefined
                    ? h(
                        'div',
                        { className: 'dsh-tools-panel-tool-status' },
                        h('span', { className: 'dsh-tools-panel-tool-error' }, t('staleHost')),
                        h('span', { className: 'dsh-tools-panel-tool-hint' }, stale)
                      )
                    : [
                        h('input', {
                          key: 'search',
                          className: 'dsh-tools-panel-tool-search',
                          type: 'search',
                          value: query,
                          placeholder: t('search'),
                          'aria-label': t('search'),
                          onChange: (event) => setQuery(event.target.value)
                        }),
                        // One action for the whole list: a panic switch has to be
                        // one gesture, not sixty. It targets what is SHOWN, so a
                        // filtered list lets the user do "everything except these".
                        // The action bar: bulk deny/allow, and the way in and out of
                        // selection mode. Selection exists for one purpose — picking
                        // the members of a new group — so the two controls sit
                        // together rather than in two places.
                        selecting
                          ? h(
                              'div',
                              { key: 'bulk', className: 'dsh-tools-panel-tool-selectBar' },
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'dsh-tools-panel-tool-bulkButton',
                                  disabled: pending || visible.length === 0,
                                  onClick: () => setSelected(new Set(visible))
                                },
                                t('selectAll')
                              ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'dsh-tools-panel-tool-bulkButton',
                                  disabled: pending,
                                  onClick: stopSelecting
                                },
                                t('clearSelection')
                              ),
                              h('span', { className: 'dsh-tools-panel-tool-selectCount' }, t('selected', { count: selected.size })),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'dsh-tools-panel-tool-bulkButton',
                                  disabled: pending || selected.size === 0,
                                  onClick: () => setDraft({ name: '' })
                                },
                                t('newGroup')
                              )
                            )
                          : h(
                              'div',
                              { key: 'bulk', className: 'dsh-tools-panel-tool-bulk' },
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'dsh-tools-panel-tool-bulkButton',
                                  disabled: pending || visible.length === 0,
                                  onClick: flipAll
                                },
                                allShownDenied ? t('allowAll') : t('denyAll')
                              ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'dsh-tools-panel-tool-bulkButton',
                                  disabled: pending || tools.length === 0,
                                  onClick: () => setSelecting(true)
                                },
                                t('select')
                              )
                            ),
                        // The naming row. It replaces nothing: it appears under the
                        // action bar while a group is being created or renamed.
                        draft === undefined
                          ? null
                          : h(
                              'div',
                              { key: 'draft', className: 'dsh-tools-panel-tool-createRow' },
                              h('input', {
                                className: 'dsh-tools-panel-tool-createInput',
                                type: 'text',
                                value: draft.name,
                                placeholder: t('groupName'),
                                'aria-label': t('groupName'),
                                autoFocus: true,
                                onChange: (event) => setDraft({ ...draft, name: event.target.value }),
                                onKeyDown: (event) => {
                                  if (event.key === 'Enter') saveDraft()
                                  if (event.key === 'Escape') setDraft(undefined)
                                }
                              }),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'dsh-tools-panel-tool-bulkButton',
                                  disabled: pending || draft.name.trim().length === 0,
                                  onClick: saveDraft
                                },
                                t('create')
                              ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'dsh-tools-panel-tool-bulkButton',
                                  onClick: () => setDraft(undefined)
                                },
                                t('cancel')
                              )
                            ),
                        h(
                          'div',
                          { key: 'list', className: 'dsh-tools-panel-tool-list' },
                          status === 'loading' || (status === undefined && data === undefined)
                            ? h(
                                'div',
                                { className: 'dsh-tools-panel-tool-status' },
                                h('span', { className: 'dsh-tools-panel-tool-note' }, t('loading'))
                              )
                            : visible.length === 0 && shownGroups.length === 0
                              ? h(
                                  'div',
                                  { className: 'dsh-tools-panel-tool-status' },
                                  h('span', { className: 'dsh-tools-panel-tool-note' }, tools.length === 0 ? t('empty') : t('noMatch'))
                                )
                              : [
                                  // Groups first. Each is a container: its members are
                                  // NOT repeated in the flat list below.
                                  ...shownGroups.map(({ group, rows }) =>
                                    h(
                                      GroupRow,
                                      {
                                        key: `group-${group.id}`,
                                        group,
                                        selected,
                                        busy: pending,
                                        open: expanded.has(group.id) || query.trim().length > 0,
                                        allowedOf: (name) => !denied.has(name),
                                        onToggleOpen: () =>
                                          setExpanded((prev) => {
                                            const next = new Set(prev)
                                            if (next.has(group.id)) next.delete(group.id)
                                            else next.add(group.id)
                                            return next
                                          }),
                                        onToggleAll: () => flipGroup(group),
                                        onRename: () => setDraft({ id: group.id, name: group.name }),
                                        onRemove: () => removeGroup(group.id),
                                        children: {
                                          empty: t('emptyGroup'),
                                          renameLabel: t('rename'),
                                          removeLabel: t('remove'),
                                          rows: rows.map((name) =>
                                            h(ToolRow, {
                                              key: `${group.id}-${name}`,
                                              name,
                                              allowed: !denied.has(name),
                                              busy: pending,
                                              selecting,
                                              selected: selected.has(name),
                                              onToggle: () => setAllowed(name, denied.has(name)),
                                              onSelect: () => toggleSelected(name)
                                            })
                                          )
                                        }
                                      }
                                    )
                                  ),
                                  // Then everything no group claims.
                                  ...ungrouped.map((name) =>
                                    h(ToolRow, {
                                      key: name,
                                      name,
                                      allowed: !denied.has(name),
                                      busy: pending,
                                      selecting,
                                      selected: selected.has(name),
                                      onToggle: () => setAllowed(name, denied.has(name)),
                                      onSelect: () => toggleSelected(name)
                                    })
                                  )
                                ]
                        ),
                        // Only a failure gets a line here; the switches say what
                        // the state is, so a summary line repeating them would just
                        // push them down the menu.
                        status === 'error'
                          ? h(
                              'div',
                              { key: 'error', className: 'dsh-tools-panel-tool-status' },
                              h('span', { className: 'dsh-tools-panel-tool-error' }, `${t('failed')}${error}`)
                            )
                          : null,
                        // No retry button when the host is stale: the request would
                        // succeed and answer the same stale shape, so offering it would
                        // invite a loop that cannot terminate.
                        status === 'error' && stale === undefined
                          ? h(
                              'button',
                              {
                                key: 'retry',
                                type: 'button',
                                className: 'dsh-tools-panel-tool-retry',
                                onClick: () => load()
                              },
                              t('retry')
                            )
                          : null
                      ]
        )
      }
    }

    function makePluginsTab(ctx) {
      return function PluginsTab({ t: seat, active }) {
      // Two seats reach this prop, and both must work. With a locale face installed
      // the renderer supplies `t(key, params)` — a bound translate function over this
      // plugin's registered namespace. Without one, `inject` below supplies the
      // dictionary itself. Normalizing here keeps a single `t(key, params)` shape
      // everywhere in the component instead of a `typeof` check at every label.
      const t = typeof seat === 'function' ? seat : translateWith(seat ?? copyFor(ctx))
      // undefined while closed, otherwise the read's phase.
      const [status, setStatus] = useState(undefined)
      const [rows, setRows] = useState([])
      const [error, setError] = useState(undefined)
      // The package name currently being switched, so only its own row goes busy.
      const [pending, setPending] = useState(undefined)
      // The manager's verdict on the last completed switch, kept until reopen.
      const [notice, setNotice] = useState(undefined)
      const [query, setQuery] = useState('')

      const load = useCallback(() => {
        setStatus('loading')
        setError(undefined)
        const active = ctx.get('locale')?.getSnapshot?.()?.active
        readPlugins(ctx, typeof active === 'string' ? active : navigator.language)
          .then((result) => {
            if (result.unavailable === true) {
              setStatus('unavailable')
              setRows([])
              return
            }
            setRows(result.rows)
            setStatus('ready')
          })
          .catch((failure) => {
            setError(String(failure?.message ?? failure))
            setStatus('error')
          })
      }, [ctx])

      // The panel owns open/close, so this tab loads when it becomes visible.
      useEffect(() => {
        if (active) load()
      }, [active, load])

      /**
       * Pin or unpin a row, and re-sort in place.
       *
       * The row's own `pinned` flag is flipped and the whole list re-sorted from
       * the state already in hand, rather than re-reading the manager: a pin changes
       * nothing on disk, so a round trip to the Host would be a slower way to learn
       * what this function already knows. Flips are independent of the switch, so
       * pinning a disabled plugin and pinning an enabled one both land at the top.
       */
      const onPin = useCallback(
        (row) => {
          const next = readPinned()
          if (next.has(row.name)) next.delete(row.name)
          else next.add(row.name)
          writePinned(next)
          setRows((current) =>
            sortRows(
              current.map((entry) =>
                entry.name === row.name ? { ...entry, pinned: next.has(row.name) } : entry
              )
            )
          )
        },
        []
      )

      const onToggle = useCallback(
        (row) => {
          const { manager } = pluginRemote(ctx)
          if (manager === undefined || typeof manager.setBundleEnabled !== 'function') {
            setNotice({ kind: 'error', text: `${t('pluginsSwitchFailed')}the Host exposes no plugin manager` })
            return
          }
          setPending(row.name)
          setNotice(undefined)
          // Both directions go through `setBundleEnabled`, which persists the choice
          // AND `reload()`s the affected patch rows into the running tree — so the
          // switch takes effect live, the way the shipped Plugins page behaves.
          //
          // The rows offered here are already bounded by `isSwitchableRow`: only
          // bundles that are dependencies of THIS profile, version-compatible (the
          // manager refuses to even list an incompatible one), and not
          // `management-required` infrastructure. That is what makes a live mount
          // safe — the alternative-runtime shells whose mount tore the Host down
          // (`dsh-acp-app`/`dsh-headless`/`dsh-sdk-app`) never reach this list.
          //
          // One asymmetry remains, and the notice says it: an enable may add a UI
          // the page does not have yet, and a disable may remove one it does, so
          // the change shows in the window only after a refresh.
          Promise.resolve(manager.setBundleEnabled(row.name, !row.enabled))
            .then((answer) => {
              if (answer === null || answer === undefined || answer.ok !== true) {
                const detail = answer?.error?.diagnostic ?? answer?.error?.message ?? answer?.error?.code
                throw new Error(detail ?? 'the switch was refused')
              }
              const outcome = answer.value
              switch (outcome?.application) {
                case 'failed':
                  throw new Error(outcome.error?.diagnostic ?? outcome.error?.code ?? 'the switch failed')
                case 'cancelled':
                  setNotice({ kind: 'warn', text: t('pluginsCancelled', { name: row.title }) })
                  break
                case 'overridden':
                  setNotice({ kind: 'warn', text: t('pluginsOverridden', { name: row.title }) })
                  break
                default:
                  // `applied`: the switch took effect live, the switch itself shows
                  // it, and success is the common case — so no banner. Only the
                  // outcomes the user has to act on (or that went wrong) get a line.
                  break
              }
              // Re-read either way: the switch may have moved other rows (a bundle
              // whose patch disables a neighbour changes that neighbour's state too),
              // and `enabled` on this row is the manager's saved answer, not ours.
              load()
            })
            .catch((failure) => {
              setNotice({ kind: 'error', text: `${t('pluginsSwitchFailed')}${String(failure?.message ?? failure)}` })
            })
            .finally(() => setPending(undefined))
        },
        [ctx, load, t]
      )

      // Follow the Host's own change events: a switch made in the shipped Plugins
      // page (or by the market) while this menu is open has to move these rows too.
      useEffect(() => {
        if (!active) return undefined
        const remote = ctx.get('remote')
        if (remote === undefined || typeof remote.$on !== 'function') return undefined
        try {
          return remote.$on('plugin-manager/changed', () => load())
        } catch {
          return undefined
        }
      }, [ctx, active, load])

      const visible = useMemo(() => {
        const needle = query.trim().toLowerCase()
        if (needle.length === 0) return rows
        return rows.filter((row) =>
          row.name.toLowerCase().includes(needle) ||
          String(row.title ?? '').toLowerCase().includes(needle)
        )
      }, [rows, query])

      // Embedded body: the panel supplies the shell, the tab bar and the trigger.
      return h(
        'div',
        { className: 'dsh-tools-panel-tabBody', role: 'tabpanel' },
                status === 'ready' && rows.length > 0
                  ? h('input', {
                      className: 'dsh-tools-panel-tool-search',
                      type: 'search',
                      value: query,
                      placeholder: t('pluginsSearch'),
                      'aria-label': t('pluginsSearch'),
                      onChange: (event) => setQuery(event.target.value)
                    })
                  : null,
                status === 'loading' || status === undefined
                  ? h('div', { className: 'dsh-tools-panel-plugin-status' }, h('span', { className: 'dsh-tools-panel-plugin-note' }, t('pluginsLoading')))
                  : status === 'unavailable'
                    ? h('div', { className: 'dsh-tools-panel-plugin-status' }, h('span', { className: 'dsh-tools-panel-plugin-note' }, t('pluginsUnavailable')))
                    : status === 'error'
                      ? h(
                          'div',
                          { className: 'dsh-tools-panel-plugin-status' },
                          h('span', { className: 'dsh-tools-panel-plugin-error' }, `${t('pluginsFailed')}${error}`)
                        )
                      : rows.length === 0
                        ? h('div', { className: 'dsh-tools-panel-plugin-status' }, h('span', { className: 'dsh-tools-panel-plugin-note' }, t('pluginsEmpty')))
                        : visible.length === 0
                          ? h('div', { className: 'dsh-tools-panel-plugin-status' }, h('span', { className: 'dsh-tools-panel-plugin-note' }, t('pluginsNoMatch')))
                          : h(
                              'div',
                              { className: 'dsh-tools-panel-plugin-list' },
                              visible.map((row) =>
                                h(PluginRow, {
                                  key: row.name,
                                  row,
                                  busy: pending === row.name,
                                  onToggle,
                                  onPin,
                                  t
                                })
                              )
                            ),
                status === 'error'
                  ? h('button', { type: 'button', className: 'dsh-tools-panel-plugin-retry', onClick: load }, t('retry'))
                  : null,
                notice === undefined
                  ? null
                  : h(
                      'div',
                      { className: 'dsh-tools-panel-plugin-status' },
                      h(
                        'span',
                        {
                          className:
                            notice.kind === 'error'
                              ? 'dsh-tools-panel-plugin-error'
                              : notice.kind === 'warn'
                                ? 'dsh-tools-panel-plugin-warn'
                                : 'dsh-tools-panel-plugin-note'
                        },
                        notice.text
                      )
                    )
      )
    }
  }

    // --- skills tab -------------------------------------------------------------
    /**
     * The skills tab: one row per skill the session can use, one switch per row.
     *
     * The switch writes `disable-model-invocation` in the skill's own SKILL.md, so
     * it is a durable, file-level answer rather than session state. A skill with no
     * file (registered by a plugin at runtime) has no row switch to offer, so its
     * switch is disabled and says why instead of pretending.
     */
    function makeSkillsTab(ctx) {
      return function SkillsTab({ t: seat, sessionId, active }) {
        const t = typeof seat === 'function' ? seat : translateWith(seat ?? copyFor(ctx))
        const activeSession = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
        const [data, setData] = useState(undefined)
        const [status, setStatus] = useState(undefined)
        const [error, setError] = useState(undefined)
        const [stale, setStale] = useState(undefined)
        const [warning, setWarning] = useState(undefined)
        const [saving, setSaving] = useState(() => new Set())
        const [query, setQuery] = useState('')
        const liveRef = useRef(true)
        const dataRef = useRef(undefined)
        useEffect(() => {
          liveRef.current = true
          return () => {
            liveRef.current = false
          }
        }, [])

        const load = useCallback((quiet) => {
          if (activeSession === undefined) {
            setError('this slot carries no session id')
            setStatus('error')
            return
          }
          if (!quiet) setStatus('loading')
          readSkills(activeSession)
            .then((next) => {
              if (!liveRef.current) return
              dataRef.current = next
              setData(next)
              setError(undefined)
              setStale(undefined)
              setStatus('ready')
            })
            .catch((failure) => {
              if (!liveRef.current) return
              if (failure instanceof StaleHostError) {
                setStale(String(failure.message))
                setData(undefined)
                setStatus('error')
                return
              }
              if (quiet && dataRef.current !== undefined) return
              setError(String(failure?.message ?? failure))
              setStatus('error')
            })
        }, [activeSession])

        useEffect(() => {
          if (active) load()
        }, [active, load])

        const toggle = useCallback((row) => {
          if (activeSession === undefined) return
          const next = !row.modelInvocable
          const previous = dataRef.current
          setSaving((prev) => new Set(prev).add(row.name))
          setWarning(undefined)
          setData((prev) => prev === undefined
            ? prev
            : {
                ...prev,
                skills: prev.skills.map((skill) =>
                  skill.name === row.name ? { ...skill, modelInvocable: next } : skill
                )
              })
          writeSkill(activeSession, row.name, next)
            .then((answer) => {
              if (!liveRef.current) return
              dataRef.current = answer.state
              setData(answer.state)
              setError(undefined)
              setStale(undefined)
              if (!answer.applied) setWarning(t('skillsWarning'))
            })
            .catch((failure) => {
              if (!liveRef.current) return
              if (previous !== undefined) {
                dataRef.current = previous
                setData(previous)
              }
              if (failure instanceof StaleHostError) {
                setStale(String(failure.message))
                setData(undefined)
                setStatus('error')
                return
              }
              setError(`${t('saveFailed')}${String(failure?.message ?? failure)}`)
            })
            .finally(() => {
              if (!liveRef.current) return
              setSaving((prev) => {
                const set = new Set(prev)
                set.delete(row.name)
                return set
              })
            })
        }, [activeSession, t])

        const skills = data?.skills ?? []
        const visible = useMemo(() => {
          const needle = query.trim().toLowerCase()
          if (needle.length === 0) return skills
          return skills.filter((skill) =>
            skill.name.toLowerCase().includes(needle) ||
            String(skill.description ?? '').toLowerCase().includes(needle)
          )
        }, [skills, query])
        const emptyText =
          data?.available === false
            ? t('skillsUnavailable')
            : data?.reason === 'no-live-agent'
              ? t('skillsNoAgent')
              : skills.length === 0
                ? t('skillsEmpty')
                : t('skillsNoMatch')

        return h(
          'div',
          { className: 'dsh-tools-panel-tabBody', role: 'tabpanel' },
          stale !== undefined
            ? h(
                'div',
                { className: 'dsh-tools-panel-tool-status' },
                h('span', { className: 'dsh-tools-panel-tool-error' }, t('staleHost')),
                h('span', { className: 'dsh-tools-panel-tool-hint' }, stale)
              )
            : [
                h('input', {
                  key: 'search',
                  className: 'dsh-tools-panel-tool-search',
                  type: 'search',
                  value: query,
                  placeholder: t('skillsSearch'),
                  'aria-label': t('skillsSearch'),
                  onChange: (event) => setQuery(event.target.value)
                }),
                h(
                  'div',
                  { key: 'actions', className: 'dsh-tools-panel-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-tools-panel-tool-bulkButton',
                      disabled: status === 'loading',
                      onClick: () => load(true)
                    },
                    t('refresh')
                  )
                ),
                h(
                  'div',
                  { key: 'list', className: 'dsh-tools-panel-tool-list' },
                  status === 'loading' || (status === undefined && data === undefined)
                    ? h(
                        'div',
                        { className: 'dsh-tools-panel-tool-status' },
                        h('span', { className: 'dsh-tools-panel-tool-note' }, t('skillsLoading'))
                      )
                    : status === 'error'
                      ? h(
                          'div',
                          { className: 'dsh-tools-panel-tool-status' },
                          h('span', { className: 'dsh-tools-panel-tool-error' }, `${t('skillsFailed')}${error}`),
                          h(
                            'button',
                            { type: 'button', className: 'dsh-tools-panel-tool-retry', onClick: () => load() },
                            t('retry')
                          )
                        )
                      : visible.length === 0
                        ? h(
                            'div',
                            { className: 'dsh-tools-panel-tool-status' },
                            h('span', { className: 'dsh-tools-panel-tool-note' }, emptyText)
                          )
                        : visible.map((row) => {
                            const busy = saving.has(row.name)
                            return h(
                              'div',
                              {
                                key: row.name,
                                className: row.modelInvocable
                                  ? 'dsh-tools-panel-skill-row'
                                  : 'dsh-tools-panel-skill-row dsh-tools-panel-skill-rowOff'
                              },
                              h(
                                'div',
                                { className: 'dsh-tools-panel-skill-meta' },
                                h('span', { className: 'dsh-tools-panel-tool-name', title: row.name }, row.name),
                                row.description === undefined || row.description.length === 0
                                  ? null
                                  : h(
                                      'span',
                                      { className: 'dsh-tools-panel-skill-desc', title: row.description },
                                      row.description
                                    ),
                                [row.provider, row.source].filter((value) => typeof value === 'string' && value.length > 0).length === 0
                                  ? null
                                  : h(
                                      'span',
                                      { className: 'dsh-tools-panel-skill-badge' },
                                      [row.provider, row.source]
                                        .filter((value) => typeof value === 'string' && value.length > 0)
                                        .join(' · ')
                                    )
                              ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  role: 'switch',
                                  className: 'dsh-tools-panel-tool-switch',
                                  'aria-checked': row.modelInvocable,
                                  'aria-label': row.name,
                                  disabled: busy,
                                  title: row.name,
                                  onClick: () => toggle(row)
                                },
                                h('span', { className: 'dsh-tools-panel-tool-thumb', 'aria-hidden': 'true' })
                              )
                            )
                          }
                        )
                      ),
                status !== 'error' && error !== undefined
                  ? h(
                      'div',
                      { key: 'saveError', className: 'dsh-tools-panel-tool-status' },
                      h('span', { className: 'dsh-tools-panel-tool-error' }, `${t('saveFailed')}${error}`)
                    )
                  : null,
                warning === undefined
                  ? null
                  : h(
                      'div',
                      { key: 'warning', className: 'dsh-tools-panel-tool-status' },
                      h('span', { className: 'dsh-tools-panel-inlineWarn' }, warning)
                    ),
                data?.complete === false
                  ? h(
                      'div',
                      { key: 'incomplete', className: 'dsh-tools-panel-tool-status' },
                      h('span', { className: 'dsh-tools-panel-tool-note' }, t('skillsIncomplete'))
                    )
                  : null
              ]
        )
      }
    }

    // --- prompts tab ------------------------------------------------------------
    /**
     * The prompt tab: the system prompt sections the session actually assembles.
     *
     * This is a VIEW of the injection, not an editor: the section text is read-only,
     * and the switch is an empty same-name shadow in the agent's scope. The list
     * includes sections injected by other plugins, which is the whole point — the
     * user can see and stop any injected prompt segment without editing a package.
     */
    function makePromptsTab(ctx) {
      return function PromptsTab({ t: seat, sessionId, active }) {
        const t = typeof seat === 'function' ? seat : translateWith(seat ?? copyFor(ctx))
        const activeSession = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
        const [data, setData] = useState(undefined)
        const [status, setStatus] = useState(undefined)
        const [error, setError] = useState(undefined)
        const [stale, setStale] = useState(undefined)
        const [warning, setWarning] = useState(undefined)
        const [saving, setSaving] = useState(() => new Set())
        const [expanded, setExpanded] = useState(() => new Set())
        const [query, setQuery] = useState('')
        const [resetArmed, setResetArmed] = useState(false)
        const resetTimer = useRef(undefined)
        const liveRef = useRef(true)
        const dataRef = useRef(undefined)
        useEffect(() => {
          liveRef.current = true
          return () => {
            liveRef.current = false
            if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current)
          }
        }, [])

        const load = useCallback((quiet) => {
          if (activeSession === undefined) {
            setError('this slot carries no session id')
            setStatus('error')
            return
          }
          if (!quiet) setStatus('loading')
          readPrompts(activeSession)
            .then((next) => {
              if (!liveRef.current) return
              dataRef.current = next
              setData(next)
              setError(undefined)
              setStale(undefined)
              setStatus('ready')
            })
            .catch((failure) => {
              if (!liveRef.current) return
              if (failure instanceof StaleHostError) {
                setStale(String(failure.message))
                setData(undefined)
                setStatus('error')
                return
              }
              if (quiet && dataRef.current !== undefined) return
              setError(String(failure?.message ?? failure))
              setStatus('error')
            })
        }, [activeSession])

        useEffect(() => {
          if (active) load()
        }, [active, load])

        const toggle = useCallback((row) => {
          if (activeSession === undefined || row.toggleable !== true) return
          const next = !row.enabled
          const previous = dataRef.current
          setSaving((prev) => new Set(prev).add(row.name))
          setWarning(undefined)
          setData((prev) => prev === undefined
            ? prev
            : {
                ...prev,
                sections: prev.sections.map((section) =>
                  section.name === row.name ? { ...section, enabled: next } : section
                )
              })
          writePrompt(activeSession, row.name, next)
            .then((answer) => {
              if (!liveRef.current) return
              dataRef.current = answer.state
              setData(answer.state)
              setError(undefined)
              setStale(undefined)
              if (!answer.applied) setWarning(t('promptsWarning'))
            })
            .catch((failure) => {
              if (!liveRef.current) return
              if (previous !== undefined) {
                dataRef.current = previous
                setData(previous)
              }
              if (failure instanceof StaleHostError) {
                setStale(String(failure.message))
                setData(undefined)
                setStatus('error')
                return
              }
              setError(`${t('saveFailed')}${String(failure?.message ?? failure)}`)
            })
            .finally(() => {
              if (!liveRef.current) return
              setSaving((prev) => {
                const set = new Set(prev)
                set.delete(row.name)
                return set
              })
            })
        }, [activeSession, t])

        const reset = useCallback(() => {
          if (activeSession === undefined) return
          if (!resetArmed) {
            setResetArmed(true)
            if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current)
            resetTimer.current = window.setTimeout(() => setResetArmed(false), 3000)
            return
          }
          setResetArmed(false)
          if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current)
          setStatus('loading')
          resetPrompts(activeSession)
            .then((next) => {
              if (!liveRef.current) return
              dataRef.current = next
              setData(next)
              setError(undefined)
              setStale(undefined)
              setWarning(undefined)
              setStatus('ready')
            })
            .catch((failure) => {
              if (!liveRef.current) return
              if (failure instanceof StaleHostError) {
                setStale(String(failure.message))
                setData(undefined)
                setStatus('error')
                return
              }
              setError(String(failure?.message ?? failure))
              setStatus('error')
            })
        }, [activeSession, resetArmed])

        const sections = data?.sections ?? []
        const visible = useMemo(() => {
          const needle = query.trim().toLowerCase()
          if (needle.length === 0) return sections
          return sections.filter((section) =>
            section.name.toLowerCase().includes(needle) ||
            String(section.text ?? '').toLowerCase().includes(needle)
          )
        }, [sections, query])
        const emptyText =
          data?.available === false
            ? t('promptsUnavailable')
            : sections.length === 0
              ? t('promptsEmpty')
              : t('promptsNoMatch')

        return h(
          'div',
          { className: 'dsh-tools-panel-tabBody', role: 'tabpanel' },
          stale !== undefined
            ? h(
                'div',
                { className: 'dsh-tools-panel-tool-status' },
                h('span', { className: 'dsh-tools-panel-tool-error' }, t('staleHost')),
                h('span', { className: 'dsh-tools-panel-tool-hint' }, stale)
              )
            : [
                h('input', {
                  key: 'search',
                  className: 'dsh-tools-panel-tool-search',
                  type: 'search',
                  value: query,
                  placeholder: t('promptsSearch'),
                  'aria-label': t('promptsSearch'),
                  onChange: (event) => setQuery(event.target.value)
                }),
                h(
                  'div',
                  { key: 'actions', className: 'dsh-tools-panel-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-tools-panel-tool-bulkButton',
                      disabled: status === 'loading',
                      onClick: () => load(true)
                    },
                    t('refresh')
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-tools-panel-tool-bulkButton',
                      disabled: status === 'loading' || (data?.disabled?.length ?? 0) === 0,
                      onClick: reset
                    },
                    resetArmed ? t('promptsResetConfirm') : t('promptsReset')
                  )
                ),
                data?.reason === 'no-live-agent'
                  ? h(
                      'div',
                      { key: 'noagent', className: 'dsh-tools-panel-tool-status' },
                      h('span', { className: 'dsh-tools-panel-tool-note' }, t('promptsNoAgent'))
                    )
                  : null,
                data?.available === false && data?.reason !== 'no-system-prompt'
                  ? h(
                      'div',
                      { key: 'unavailable', className: 'dsh-tools-panel-tool-status' },
                      h(
                        'span',
                        { className: 'dsh-tools-panel-tool-note' },
                        data.reason === 'assemble-failed'
                          ? `${t('promptsAssembleFailed')}: ${data.error ?? ''}`
                          : t('promptsUnavailable')
                      )
                    )
                  : null,
                h(
                  'div',
                  { key: 'list', className: 'dsh-tools-panel-tool-list' },
                  status === 'loading' || (status === undefined && data === undefined)
                    ? h(
                        'div',
                        { className: 'dsh-tools-panel-tool-status' },
                        h('span', { className: 'dsh-tools-panel-tool-note' }, t('promptsLoading'))
                      )
                    : status === 'error'
                      ? h(
                          'div',
                          { className: 'dsh-tools-panel-tool-status' },
                          h('span', { className: 'dsh-tools-panel-tool-error' }, `${t('promptsFailed')}${error}`),
                          h(
                            'button',
                            { type: 'button', className: 'dsh-tools-panel-tool-retry', onClick: () => load() },
                            t('retry')
                          )
                        )
                      : visible.length === 0
                        ? h(
                            'div',
                            { className: 'dsh-tools-panel-tool-status' },
                            h('span', { className: 'dsh-tools-panel-tool-note' }, emptyText)
                          )
                        : visible.map((row) => {
                            const busy = saving.has(row.name)
                            const open = expanded.has(row.name)
                            return h(
                              'div',
                              {
                                key: row.name,
                                className: [
                                  'dsh-tools-panel-prompt-row',
                                  row.enabled ? '' : 'dsh-tools-panel-prompt-rowOff',
                                  row.present === false ? 'dsh-tools-panel-prompt-rowMissing' : ''
                                ].filter(Boolean).join(' ')
                              },
                              h(
                                'div',
                                { className: 'dsh-tools-panel-prompt-head' },
                                h(
                                  'button',
                                  {
                                    type: 'button',
                                    className: 'dsh-tools-panel-prompt-name',
                                    'aria-expanded': open,
                                    title: row.name,
                                    onClick: () =>
                                      setExpanded((prev) => {
                                        const next = new Set(prev)
                                        if (next.has(row.name)) next.delete(row.name)
                                        else next.add(row.name)
                                        return next
                                      })
                                  },
                                  row.name
                                ),
                                h('span', { className: 'dsh-tools-panel-prompt-global' }, t('promptsGlobal')),
                                h(
                                  'button',
                                  {
                                    type: 'button',
                                    role: 'switch',
                                    className: 'dsh-tools-panel-tool-switch',
                                    'aria-checked': row.enabled,
                                    'aria-label': row.name,
                                    disabled: row.toggleable !== true || busy,
                                    title: row.reason === 'sole-section'
                                      ? t('promptsSole')
                                      : row.toggleable !== true
                                        ? t('promptsSole')
                                        : row.name,
                                    onClick: () => toggle(row)
                                  },
                                  h('span', { className: 'dsh-tools-panel-tool-thumb', 'aria-hidden': 'true' })
                                )
                              ),
                              h(
                                'div',
                                {
                                  className: 'dsh-tools-panel-prompt-preview',
                                  onClick: () =>
                                    setExpanded((prev) => {
                                      const next = new Set(prev)
                                      if (next.has(row.name)) next.delete(row.name)
                                      else next.add(row.name)
                                      return next
                                    })
                                },
                                row.text.length === 0 ? t('promptsEmptyText') : String(row.text).split('\n')[0]
                              ),
                              row.present === false
                                ? h('span', { className: 'dsh-tools-panel-prompt-note' }, t('promptsMissing'))
                                : null,
                              open
                                ? h(
                                    'pre',
                                    { className: 'dsh-tools-panel-prompt-text' },
                                    row.text.length === 0 ? t('promptsEmptyText') : row.text
                                  )
                                : null,
                              open && row.truncated === true
                                ? h('span', { className: 'dsh-tools-panel-prompt-note' }, t('promptsTruncated'))
                                : null
                            )
                          }
                        )
                      ),
                status !== 'error' && error !== undefined
                  ? h(
                      'div',
                      { key: 'saveError', className: 'dsh-tools-panel-tool-status' },
                      h('span', { className: 'dsh-tools-panel-tool-error' }, `${t('saveFailed')}${error}`)
                    )
                  : null,
                warning === undefined
                  ? null
                  : h(
                      'div',
                      { key: 'warning', className: 'dsh-tools-panel-tool-status' },
                      h('span', { className: 'dsh-tools-panel-inlineWarn' }, warning)
                    )
              ]
        )
      }
    }

    // --- the panel shell ---------------------------------------------------------
    /**
     * The one control: a trigger, a menu, and four tabs.
     *
     * The shell owns only what is COMMON — the open state, the anchor, dismissal, the
     * tab bar, and the menu frame. Each tab keeps its own state and its own Host
     * conversation, so switching tabs does not throw away a search string, a
     * selection, or a loaded plugin list. All four tabs are mounted the whole time and
     * merely hidden: unmounting an inactive one would re-read its Host data on every
     * tab switch.
     */
    function makePanel(ctx) {
      return function ToolsPanel({ t: seat, sessionId }) {
        const t = typeof seat === 'function' ? seat : translateWith(seat ?? copyFor(ctx))
        const [open, setOpen] = useState(false)
        // The remembered tab, restored on mount: the user's last choice outlives the
        // menu, the session, and a reload of the page.
        const [tab, setTab] = useState(readTab)
        const [anchor, setAnchor] = useState(undefined)
        const triggerRef = useRef(null)
        const rootRef = useRef(null)
        // The menu lives in a portal under `document.body`, so it is NOT inside
        // `rootRef`; dismissal has to test both subtrees or a click on a tab would
        // close the menu before its own handler ran.
        const menuRef = useRef(null)

        const openMenu = useCallback(() => {
          const rect = triggerRef.current?.getBoundingClientRect()
          if (rect !== undefined) {
            // Opens upward: the trigger sits at the bottom of the viewport. Anchoring
            // by `bottom` lets the menu size itself without a measuring pass.
            setAnchor({
              left: Math.min(Math.max(8, rect.left), window.innerWidth - MENU_WIDTH - 8),
              bottom: Math.max(MENU_GAP, window.innerHeight - rect.top + MENU_GAP),
              maxHeight: Math.max(160, Math.min(MENU_MAX_HEIGHT, rect.top - 16))
            })
          }
          setOpen(true)
        }, [])

        const close = useCallback(() => setOpen(false), [])

        /** Switch tabs, and remember the choice. */
        const chooseTab = useCallback((next) => {
          setTab(next)
          writeTab(next)
        }, [])

        // Dismiss on mousedown elsewhere or Escape. No scroll listener: this control
        // sits on the input toolbar, next to the conversation's own scroller, so a
        // capture-phase `scroll` would fire for every scroll of the transcript and
        // close the menu while the user is still reading it. The shipped model
        // selector in the same row listens for `mousedown` only and stays open on
        // scroll; the menu follows that.
        useEffect(() => {
          if (!open) return undefined
          const dismiss = (event) => {
            for (const ref of [rootRef, menuRef]) {
              const node = ref.current
              if (node !== null && event.target instanceof Node && node.contains(event.target)) return
            }
            setOpen(false)
          }
          const onKeyDown = (event) => {
            if (event.key === 'Escape') setOpen(false)
          }
          document.addEventListener('mousedown', dismiss)
          document.addEventListener('keydown', onKeyDown)
          return () => {
            document.removeEventListener('mousedown', dismiss)
            document.removeEventListener('keydown', onKeyDown)
          }
        }, [open])

        const Tools = useMemo(() => makeToolsTab(ctx), [ctx])
        const Skills = useMemo(() => makeSkillsTab(ctx), [ctx])
        const Prompts = useMemo(() => makePromptsTab(ctx), [ctx])
        const Plugins = useMemo(() => makePluginsTab(ctx), [ctx])

        /** One tab button. `aria-selected` is the contract a tablist needs. */
        const tabButton = (id, label) =>
          h(
            'button',
            {
              key: id,
              type: 'button',
              role: 'tab',
              className:
                tab === id
                  ? 'dsh-tools-panel-tab dsh-tools-panel-tabActive'
                  : 'dsh-tools-panel-tab',
              'aria-selected': tab === id,
              onClick: () => chooseTab(id)
            },
            label
          )

        const menu =
          !open || anchor === undefined || typeof document === 'undefined'
            ? null
            : createPortal(
                h(
                  'div',
                  {
                    ref: menuRef,
                    className: 'dsh-tools-panel-menu',
                    role: 'dialog',
                    'aria-label': t('title'),
                    // BOTH height and max-height: a flex column whose only height
                    // constraint is `max-height` still lays its children out at their
                    // natural size, so `flex: 1` below it has nothing to divide and
                    // every list ends up with no scroll range. Anchoring by `bottom`
                    // plus an explicit `height` gives the chain a definite number.
                    style: {
                      left: `${anchor.left}px`,
                      bottom: `${anchor.bottom}px`,
                      height: `${anchor.maxHeight}px`,
                      maxHeight: `${anchor.maxHeight}px`
                    }
                  },
                  h(
                    'div',
                    { className: 'dsh-tools-panel-tabs', role: 'tablist', 'aria-label': t('title') },
                    tabButton('tools', t('tabTools')),
                    tabButton('skills', t('tabSkills')),
                    tabButton('prompts', t('tabPrompts')),
                    tabButton('plugins', t('tabPlugins'))
                  ),
                  // Both tabs stay MOUNTED; the inactive one is hidden with `display`
                  // so its state (and its loaded list) survives a switch. Hidden rather
                  // than unmounted is also what keeps the tool tab's poll from running
                  // while the user is on the plugin tab — the tab itself gates on
                  // `active`.
                  h(
                    'div',
                    { className: 'dsh-tools-panel-body' },
                    h(
                      'div',
                      {
                        className: 'dsh-tools-panel-pane',
                        style: tab === 'tools' ? undefined : { display: 'none' }
                      },
                      h(Tools, { sessionId, active: tab === 'tools' })
                    ),
                    h(
                      'div',
                      {
                        className: 'dsh-tools-panel-pane',
                        style: tab === 'skills' ? undefined : { display: 'none' }
                      },
                      h(Skills, { sessionId, active: tab === 'skills' })
                    ),
                    h(
                      'div',
                      {
                        className: 'dsh-tools-panel-pane',
                        style: tab === 'prompts' ? undefined : { display: 'none' }
                      },
                      h(Prompts, { sessionId, active: tab === 'prompts' })
                    ),
                    h(
                      'div',
                      {
                        className: 'dsh-tools-panel-pane',
                        style: tab === 'plugins' ? undefined : { display: 'none' }
                      },
                      h(Plugins, { active: tab === 'plugins' })
                    )
                  )
                ),
                document.body
              )

        return h(
          'div',
          { className: 'dsh-tools-panel-root', ref: rootRef },
          h(
            'button',
            {
              ref: triggerRef,
              type: 'button',
              className: 'dsh-tools-panel-trigger',
              'aria-haspopup': 'dialog',
              'aria-expanded': open,
              'aria-label': t('title'),
              title: t('title'),
              onClick: () => (open ? close() : openMenu())
            },
            h(ShieldIcon, { active: false }),
            h(ChevronIcon, { open })
          ),
          menu
        )
      }
    }

    // --- plugin -----------------------------------------------------------------
    function apply(ctx) {
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`)
        if (existing !== null) return () => {}
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-plugin-tools-panel'
        tag.dataset.pluginCss = CSS_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'tools-panel: stylesheet')

      // The dictionary is registered only when a locale face exists. The entry's own
      // `locale` option is set on the same condition: the renderer throws for an
      // entry that declares a namespace no locale face can answer, so the two must
      // agree. Without one, `t` arrives as a prop from `inject` instead.
      let locale
      try {
        locale = ctx.get('locale')
      } catch {
        locale = undefined
      }
      if (locale !== undefined && typeof locale.register === 'function') {
        ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'tools-panel: dictionaries')
      }

      ctx.slots.inject(SLOT, () =>
        ctx.slots.register(
          {
            name: SLOT,
            id: ID,
            order: ORDER,
            ...(locale === undefined ? {} : { locale: NS }),
            // With no locale face the component cannot receive a `t` seat, so a
            // translate function over the dictionary is handed to it as a plain prop
            // instead. Both spellings arrive as the same `t(key, params)` prop.
            inject: () => (locale === undefined ? { t: translateWith(copyFor(ctx)) } : {})
          },
          makePanel(ctx)
        )
      )
    }

    // The loader gates apply() until the declared services exist.
    return { apply, inject: ['slots'] }
  }
})
