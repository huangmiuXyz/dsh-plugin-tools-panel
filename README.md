# dsh-plugin-tools-panel

输入框工具条上的**一个**面板，四个 tab。「工具」逐个实时禁用当前会话能调用的工具；
「技能」启停技能对模型的可见性；「提示词」启停已经注入系统提示词里的段落；「插件」启停
整个 profile 的插件。

合并前这是两个独立插件（`dsh-tool-guard`、`dsh-plugin-switch`），各占工具条一个按钮。
两个下拉回答的是同一个问题——"这个会话现在能用什么"——并排放着逼用户两个都点一遍才
知道全貌。现在一个触发器、一个菜单、一条关闭路径，tab 只换菜单内容，各自的状态（搜索词、
勾选、已读到的插件列表）切换 tab 不丢。后加的两个 tab 沿用同一套外壳：都是**列出宿主
已经存在的东西**再决定开关，不从面板里凭空创建任何提示词。

## 四个 tab

### 工具

清单一律是**当前会话真正能调用的工具**：读宿主注册表（`ctx.tools.schemas(agent)`），装了
MCP 服务器就多几行，预设没挂工具就一行都没有、显示"没有可用的工具"。代码里没有任何工具名。

关掉一个工具的开关，宿主会：

1. **隐藏（主）**——在 `system-prompt/assemble` 阶段把禁用名从交给模型的 schema 列表里去掉。
   模型看不到就不会调它，顺带省下每个请求的 schema 体积。监听器只注册**一次**（挂在插件
   自己的 context 上）：该 waterfall 通过 `scopeTarget` 派发，而作用域过滤器对"没有作用域
   的注册"一律放行，所以一个监听器覆盖所有现存 agent 和之后新建的 agent——不需要逐个挂载、
   不需要重新同步、agent 销毁时也没有东西要清理。
2. **拦截（兜底）**——`ctx.tools.guard()` 每次调用重新解析禁用集合。过滤只影响"模型看到
   什么"，管不到从历史里来的调用、已恢复会话的请求头、以及 PTC 子派发，这些由 guard 拦，
   回执：

```
此操作已被用户实时禁用：工具「write」未执行，且不要再尝试调用。This tool is disabled live
by the user: "write" was not executed. Do not retry it — continue with what the user allows,
or tell the user what you need.
```

### 为什么不用 `ctx.tools.restrict()`（曾经的 bug）

`restrict()` 是宿主文档里"隐藏一个工具"的标准做法，但它**只过滤继承来的贡献，从不动本层
自己注册的工具**。这条豁免是委派机制依赖的：子 agent 的专属工具就是注册进它自己那一层的，
一个"按子 agent 能力裁剪"的过滤器不能把机制本身裁掉。

结果就是 agent 本层注册的工具（`subagent`、`team_task_*`、`wait_agent`、`interrupt_agent`、
`list_agents`、`list_subagent_models` 这一族）调用 `restrict()` 一律抛
`unknown global tool`。开关显示为关，模型照旧看得见、照旧能试——只能靠 guard 在调用时拒绝，
这就是"全部禁用后这些工具还是残留"的真实原因。

改成过滤组装好的 schema 列表之后就不再区分工具注册在哪一层：预设工具和 agent 本层工具被
同样移除。代价是这个 waterfall 的返回值会替换整个 assembly，宿主插件规范明确不建议用它
增删工具——所以监听器写得尽可能窄：先 `await next()`，保留它给出的每一个字段，只替换
`tools` 一个字段，不新增、不重排、不碰 `sections`/`contexts`/`variables`。

判断有没有修好的证据是 `masked`：它数的是"禁用名里从注册表视图里消失了的个数"。注意
`schemas(agent)` 是注册表视图，过滤器在组装阶段才运行、不改写它，所以 agent 本层工具仍会
出现在这个数里是**正常的**；这个数真正用来发现的反而是反面情况——某个工具因为插件卸载等
原因消失，让开关看起来生效了，其实只是没挂载。

界面：可搜索、可滚动，每行只有工具名和一个开关（不写说明文字，省一屏的行数），搜索框按
名字过滤。

**手动分组**：点「创建分组」进入多选，勾好工具后点「建组」命名；「取消创建」退出多选。
一个组在清单里是一行，带展开箭头、成员数和**组总开关**。组只是视图 + 批量操作，没有自己
的策略：组开关是从成员的禁用状态**算出来的**，所以组和工具不可能矛盾。一个工具可以同时在多个组里；被组收走的工具不再出现在下面的扁平
列表，所以组是容器不是过滤器。组可重命名、可删除，删组不动任何开关。

**分组定义和禁用状态都写盘**：分组在 `groups.json`，禁用在 `tools.json`（都在
`$DSH_HOME/dsh-plugin-tools-panel/` 下），**重启后都还在**。

禁用是**全局的**：关掉一个工具，所有会话（含子 agent）都不再能用它，不只是当前这个对话。
这是刻意和技能、提示词两个 tab 对齐的——三个 tab 用的是同一种开关，就不该有三种不同的
生命周期。旧版本是"仅本会话、只在内存、重启全开"的紧急刹车，那个语义已经去掉。

### 技能

清单是当前会话能用的技能（`ctx.skills.snapshot({ cwd, scope: agent })`），一行一个，开关就是
**彻底禁用**它：模型看不到、`/技能名` 也调不到。只有一条路，对所有技能一视同仁：

- 关掉 = 在该 agent 的作用域里注册一个**同名空技能**，`modelInvocable` 与 `userInvocable`
  都是 `false`。技能目录按作用域分层合并、最近的一层覆盖祖先层，所以空影子盖住原件：模型目录
  把它过滤掉，`/技能名` 的注入路径也跳过它——**两条调用路径都断**。
- 对插件注入的、DSH 内置的技能同样有效：它们没有可改的文件，旧的 frontmatter 方案对它们
  无能为力，这正是这个 tab 以前只能禁用一半技能的原因。
- **关掉时不修改任何技能文件**，也不碰插件源码。唯一的例外是**打开**一个文件里本来就写着
  `disable-model-invocation: true` 的技能（上一版面板写的，或技能作者自己关的）：影子只能
  增加禁用、不能撤销文件里的 key，所以「开」会清掉那一行——只动这一个顶层 key，其余内容
  原样保留。
- 代价是这套开关属于"本插件的管理"：插件被卸载或停用后，所有技能会恢复可用。
- 写完会强制技能注册表重新收集，再读一次确认 `modelInvocable` 真的变了；没变就**撤销影子**
  并回滚落盘，在面板上直说，而不是让开关看起来关了、实际还开着。

### 提示词

这个 tab **不创建、不编辑任何提示词**。它列出当前会话**已经装配进系统提示词**的段落
（`ctx.systemPrompt.assemble({ agent, scope: agent })` 的 `sections`），一段一行，可以展开
看原文，也可以按段关掉。

- 关掉一段 = 在 `system-prompt/assemble` 阶段把这一段从装配好的 `sections` 里**删掉**。和工具
  tab 共用同一个窄监听器（只注册一次，覆盖所有 agent）。不碰任何插件的源码或数据文件，升级
  插件不会被覆盖。
- 之前用的是"在该 agent 的作用域里注册一个同名空段落"来覆盖——那条路有一个和工具完全相同的
  毛病：**agent 自己注册的段落藏不掉**（只覆盖继承来的层），那种情况只能回 `409`。改成直接删
  段落之后不再区分注册在哪一层。两者的渲染结果本来就等价：`renderPrompt` 会把空文本的段落
  丢掉（`.filter((text) => text.length > 0)`）。
- 改动**全局生效、重启还在**（`$DSH_HOME/dsh-plugin-tools-panel/prompts.json`），下一条消息
  生效——agent loop 每一步都重新装配系统提示词。
- 宿主会当场**验证**：重新装配后这段真的不在了才回 `applied`；唯一的例外是标了
  `complete: true` 的段落——宿主要在 waterfall 之后把它塞回去，这种段落任何监听器都删不掉，
  宿主回滚并回 `409` 说明原因，面板把拒绝原因显示出来。它也会拒绝把提示词关空的写法。
- 「全部恢复」清空整个开关集合，两下确认（防误触）。

### 插件

列出这个 profile 已安装的插件（`remote.pluginManager.listBundles()`），每个一个开关，走官方
`setBundleEnabled`，所以改动**实时生效**，和官方插件页行为一致。可收藏置顶（存在浏览器
localStorage）。不可开关的行会写明原因：宿主基础设施（`management-required`）、不在补丁层
（`unaddressable`）、不是插件（`not-bundle`）。未安装进本 profile 的替代运行时（`dsh-acp-app`、
`dsh-headless`、`dsh-sdk-app`）**不会**被列出来——把它们组进去会抢同一批槽位、把宿主搞崩。

列表上方有搜索框，按**包名**或**本地化标题**过滤；没有匹配时直接写"没有匹配的插件"，而不是
留一个空列表。

## 作用范围

禁用集合是**整个 profile 的**，没有会话维度：关掉一个工具，当前会话、它派生的子会话
（`subagent`、`workflow` 里的 `agent()`）、以及之后新建的任何会话，都一起被拦。所以
"派个子 agent 去干"不是绕过，换一个会话也不是。

三个 tab 的语义现在是一致的：都是"这个环境里我不要什么"，都写盘、都重启还在。区别只在
禁用的对象——工具按名字、技能按名字、提示词段落按名字。

## 界面细节

触发按钮在输入框工具条右侧（`conversation.input.right`），**只有图标**——那一行还要放模型
选择器，文字标签只是重复 tooltip。菜单开放时向上展开并 portal 到 `document.body`：工具条那
一层设了 `container-type: inline-size`，就地渲染的 `fixed` 菜单会被裁剪成 36px 高。

tab 条是四个等宽的分段按钮（工具 | 技能 | 提示词 | 插件），`role="tablist"` /
`role="tab"` / `aria-selected`。**四个 tab 始终挂载**，非活动的用 `display:none` 隐藏：卸载会
丢状态，还会让插件 tab 每次切换都重读一遍磁盘上所有 manifest。工具 tab 的轮询只在它是活动
tab 时才跑；技能/提示词 tab 在第一次变成活动 tab 时读一次，之后由「刷新」按钮或开关的写入
结果更新。

**上次用的 tab 会被记住**（localStorage），首次打开默认停在**插件**。菜单打开时工具 tab 每
2 秒轮询一次宿主，所以另一个窗口改了开关也能跟上。

## 安装

```jsonc
// <profile>/package.json
{
  "dependencies": { "dsh-plugin-tools-panel": "link:/path/to/dsh-plugin-tools-panel" },
  "dsh": { "profile": { "bundles": [/* …, */ "dsh-plugin-tools-panel"] } }
}
```

然后 `pnpm install`，重启或刷新。`cordis.patch.yml` 那行不能少：它是 `exports["./client"]`
唯一会被 `dsh-client-modules` 扫到的原因。

**客户端半边随 HMR 热更新，宿主半边不会。** 改 `src/client.js` 刷新页面即可；改
`src/index.js`（隐藏逻辑、路由、分组落盘）必须重启 DSH。

### 版本错配会明说

两个半边各自声明 `PROTOCOL`。快照里带 `protocol`，客户端发现对不上就不显示清单，直接说
"宿主端还是旧版本，请重启 DSH"；宿主收到既没有 `deny` 也没有 `groups` 的请求返回 `409`。
改字段名或状态形状时**两边一起加一**，自检里有一条断言盯着这个数字是否一致。当前：`8`。

## 接口

`GET /dsh-plugin-tools-panel/state?sessionId=<id>` →
```jsonc
{ "ok": true, "state": {
  "protocol": 9, "sessionId": "…",
  "tools": ["bash", "…"],          // 本会话可见（含已禁用），已排序
  "denied": ["write"],             // 全局生效的禁用集合（写盘，重启还在）
  "groups": [{ "id": "g1", "name": "编辑", "members": ["write", "edit"] }],
  "scopes": 4,                     // 挂了限制的 agent 作用域数
  "masked": 1,                     // 真的从模型视图里消失的禁用名个数
  "blocked": 0, "last": null       // guard 兜底计数与最后一次拦截
}}
```

`POST` body 为 `{ sessionId, deny?: string[], groups?: { id?, name, members }[] }`，**整表替换**，
两个字段可同时写。必须带 `x-dsh-plugin-tools-panel` 请求头——跨源页面可以不带预检地发简单
请求，要求自定义头才逼出预检、让浏览器拦下它。`deny` 非数组 → `400`；两个字段都没有 → `409`。

### 技能与提示词接口（协议 8）

`GET /dsh-plugin-tools-panel/skills?sessionId=<id>` →
```jsonc
{ "ok": true, "state": {
  "protocol": 9, "sessionId": "…", "available": true, "complete": true,
  "skills": [{
    "name": "blender-modeling", "description": "…", "provider": "fs", "source": "user",
    "path": "/home/…/SKILL.md",        // 真实文件路径；没有它就没有可写的开关
    "modelInvocable": true, "userInvocable": true, "toggleable": true
  }]
}}
```
没有技能服务时 `available:false`；会话没在运行时 `reason:"no-live-agent"`、清单为空。

`POST /dsh-plugin-tools-panel/skills` body `{ sessionId, name, enabled }`，改写该技能
`SKILL.md` 的 `disable-model-invocation`。回 `{ ok:true, state, applied }`；`applied:false`
表示文件写了但目录还没反映出来。`name` 不认识 → `404`；没有文件、文件正在被别人改、
frontmatter 没闭合 → `409`。必须带同一个请求头。

`GET /dsh-plugin-tools-panel/prompts?sessionId=<id>` →
```jsonc
{ "ok": true, "state": {
  "protocol": 9, "sessionId": "…", "available": true, "disabled": ["workspace"],
  "sections": [{
    "name": "identity", "text": "…（≤4000 字，超出截断）", "chars": 128,
    "truncated": false, "enabled": true, "present": true, "liveChars": 128,
    "toggleable": true
  }]
}}
```
`sections` 保持装配顺序；`liveChars` 是当前装配里这一段的真实长度（关掉的段落为 0），
`chars` 是预览长度（关掉的段落用上一次看到的文本，所以仍然能预览）。`present:false` 表示
这个开关还在、但当前装配里没有这一段。

`POST /dsh-plugin-tools-panel/prompts` body `{ sessionId, name, enabled }` 或
`{ sessionId, reset: true }`。关掉一段会在该 agent 作用域注册空段落，然后**重新装配验证**；
验证不过（段落遮不住、或关掉后提示词为空）就回滚并回 `409`，`applied` 只在真生效时为 `true`。
同样要求该请求头。

`scopes` 是"隐藏挂上了几个作用域"，`masked` 是"禁用名里真的看不见了几个"。被隐藏的工具根本
到不了 guard，所以 `blocked` 不为零就说明有东西只能靠兜底拦住——这两个数字是排查时读一次
JSON 就能定位的证据，界面上不显示。

## 自检

```bash
node test/check.mjs
```

373 条断言，覆盖：清单与 patch、两个半边都不引入外部包（`node:` 内置模块除外，本包用
`link:` 安装）、逐工具判定、全局禁用集合的规范化与落盘（含重启后仍生效）、分组规范化与落盘、请求体清洗、真实 `node:http` 服务器跑
通的整条链路（缺头 403、`deny` 非数组 400、两字段全无 409、未知工具名不炸整份限制、晚注册
工具也会被隐藏），以及用**伪 React 渲染器**跑通的界面：一个触发器、四个 tab、tab 记忆、
四个 tab 都保持挂载、插件 Remote 调用、过滤未安装运行时、插件搜索与空结果、收藏置顶持久化、
没有插件管理器时面板仍然打开、技能行与开关（文件型与运行时型走同一条作用域影子）、技能关掉后
两条调用路径都断、关掉时不改写技能文件、文件自带禁用键时「开」会清掉那一行、开关集合落盘、
提示词段落列出与开关、
空段落遮蔽、无法遮蔽时的回滚、唯一段落拒绝、全部恢复。

技能/提示词一组还单独覆盖了 frontmatter 补丁（新增 key、翻转、CRLF、BOM、缩进同名项、
未闭合拒绝）、禁用集合的规范化与落盘、服务缺席与会话未启动时的回答，以及 `409` 失败后
**磁盘与内存都不留下**一个假开关。

其中 `layers:` 一组是上面那个 bug 的回归测试：伪宿主把工具分到**预设层**和**全局层**两层
（和真实宿主一致），断言禁用预设工具时它真的从该 agent 的可见列表里消失、掩码确实施在了
预设层、且只施一次、放开后两层都恢复。

测试把 `DSH_HOME` 指向临时目录再导入模块，绝不碰真实 profile；跑完删掉。
