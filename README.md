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

清单一律是**当前会话能看到的工具**：读宿主装配好的**目录**——`system-prompt/assemble` 返回
的 `tools`（所有装配期过滤器跑完之后的样子），读不到时回退到注册表视图
`ctx.tools.schemas(agent)`。所以预设把目录清空（"空白模式"）就一行都没有、显示"没有可用的
工具"；预设只挂一部分工具就只列那一部分；装了 MCP 服务器就多几行。代码里没有任何工具名。

**"装配目录"不是模型请求里的工具声明。** 请求的 schema 列表是注册表投影
`ctx.tools.schemas(agent)`——会话日志里的 `request/header.tools` 就是它。两个视图都能回答
"这个会话有什么"，但只有注册表投影决定模型能不能调用。所以这个插件两个都改：注册表投影走
`restrict()`（真正生效），装配目录走过滤（面板与其他 prompt 消费方看到的一致视图）。

关掉一个工具的开关，宿主会：

1. **隐藏（主）**——在每个 live agent 的作用域里挂一条 `ctx.tools.restrict({ deny })`，把
   禁用名从模型请求的工具声明里去掉。模型看不到就不会调它，顺带省下每个请求的 schema 体积。
   限制是**显式注册**，所以禁用集合一变就得重挂：`setDeny()` 通过 `onDenyChanged` 通知所有
   已挂载作用域重新同步。
2. **目录过滤（展示）**——同一个 `system-prompt/assemble` 监听器把禁用名从装配目录里删掉，
   面板的清单、以及别的插件读的 "model-facing catalog" 跟着走。它**不改变模型收到的声明**；
   它的价值是让视图与策略一致，并覆盖 `restrict()` 结构上擦不掉的 agent 本层工具。监听器只
   注册**一次**（挂在插件自己的 context 上）：该 waterfall 通过 `scopeTarget` 派发，而作用
   域过滤器对"没有作用域的注册"一律放行，所以一个监听器覆盖所有现存 agent 和之后新建的
   agent。
3. **拦截（兜底）**——`ctx.tools.guard()` 每次调用重新解析禁用集合。隐藏只影响"模型被广告
   什么"，管不到从历史里来的调用、已恢复会话的请求头、以及 PTC 子派发，这些由 guard 拦，
   回执：

```
此操作已被用户实时禁用：工具「write」未执行，且不要再尝试调用。This tool is disabled live
by the user: "write" was not executed. Do not retry it — continue with what the user allows,
or tell the user what you need.
```

### `restrict()` 的边界（它挡不住的东西）

`restrict()` 是宿主文档里"隐藏一个工具"的标准做法，但它**只过滤继承来的贡献，从不动本层
自己注册的工具**。这条豁免是委派机制依赖的：子 agent 的专属工具就是注册进它自己那一层的，
一个"按子 agent 能力裁剪"的过滤器不能把机制本身裁掉。

结果：agent 本层注册的工具（`spawn_teammate`、`team_task_*`、`wait_agent` 这一族，以及
某些按 agent 注册的插件工具）**无法**从模型请求里删掉——不是插件少调了一次，是宿主契约
不允许。对这些名字插件只能：
- 目录过滤照旧把它们从面板的清单视图里去掉；
- guard 在调用时拒绝（禁用语义）；
- 快照里如实报告：`unmaskable` 是"这个会话里宿主没让我藏起来"的名字，`masked` 是"隐藏名里
  真的从注册表投影里消失了几个"。排查"开关关了、模型还看得见"时读这两个数，不用加调试器。

代价还有个边界：`restrict()` 在调用时校验名字，所以在开关写下之后才注册的工具（MCP 服务器
重连）不在掩码里——它下一次策略变更（再开关一次、加载/卸载分组）时被补上。这段时间 guard
仍然拒绝调用。

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

### 渐进式披露（协议 10）

一组工具可以**选择被延后**：给它写一句"这组是干什么的"，开了披露之后，组内工具的 schema
不再出现在模型请求的工具声明里（和"禁用"走同一套按 agent 作用域的 `restrict()`），只在系统
提示词里留一行索引。模型需要时调用 `get_tools`，这组工具从**下一步**起出现在工具列表里。

- 索引段落名 `tools-panel:deferred-tools`，`text` 是**每次装配求值的函数**，所以每个会话只看
  到自己还没加载的组。内容是：组名 + 你写的描述提示词 + 成员数，**不列工具名**。
- 只要存在至少一个这样的组，就自动注册工具 `get_tools`（没有披露组时它不存在）。不带参数先
  列目录；带 `group`（组名或 id）就是**加载**这组。
- **加载必须在同一刻把掩码摘掉**：`unlockGroup()` 通过 `onUnlockChanged` 让所有已挂载作用域
  重新同步，所以下一步请求就带着这组工具。少了这一步，掩码会在解锁后继续存在——工具从模型
  的清单里永久消失（而且因为不再算"已延后"，面板也不列它们了），这就是 "`get_tools` 说已
  加载、工具却没出现" 的那个 bug。`hide`（卸载）走同一个钩子，反向重挂。
- 组里有 agent 本层工具时，它们藏不掉（见上一节的边界）：披露省不到那点 schema，但工具本身
  仍然可见——披露是省上下文，不是权限。
- `get_tools` 的返回**只有一句确认**，不带任何工具名、说明或参数 schema：工具本身下一步就会
  带着真实 schema 出现在工具列表里，在这里再抄一遍等于让模型读两遍 schema。
- **加载是本会话的、只在内存**：新会话或重启 DSH 都回到未加载；子 agent 通过委派树**继承**
  父会话已加载的组，所以"派个子 agent 去拿"不会绕过披露。
- **手动卸载**：加载过的组在组行上多一个「卸载」按钮，点一下就把这组重新隐藏；弹窗里也有同一
  个动作。它只改本会话的已加载集合，**不动分组定义**，组仍处于披露状态、模型以后还能再加载。
- **披露不是权限**：被延后的工具只是"没被广告"，并没有被禁用，guard 不会拒绝它，面板里它照旧
  有自己的开关。禁用与披露叠加时互不覆盖：被禁用的工具加载后仍然是禁用状态。
- 定义（含 `disclosure` 与描述提示词）照旧写进 `groups.json`，跨会话保留。
- **模型也能配置**：`manage_tool_groups` 的 `set_disclosure` 动作（`group` + `disclosure` 和/或
  `prompt`，两者都可省略一个）改的就是弹窗里同样两个字段，写入即生效。

模型看到的索引大概长这样：

```
## Deferred tool groups
The tools of the groups below are not loaded in this conversation, so they are not in your tool list yet.
Call `get_tools` with a group name or id to load that group: the tools are injected into your tool list
from the next step on, with their own descriptions and parameter schemas, ...
- Git：用于 Git 操作，查看状态、提交、分支管理。 (4 tools)
```

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

**例外是渐进披露的"已加载"**：它记的是"这个会话的模型已经取了这组工具"，属于会话事实，
所以按会话存在内存里、重启或新会话即失效（见上文）。

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
"宿主端还是旧版本，请重启 DSH"；宿主收到既没有 `deny`、也没有 `groups`、也没有 `hide` 的请求
返回 `409`。改字段名或状态形状时**两边一起加一**，自检里有一条断言盯着这个数字是否一致。
当前：`10`。

## 接口

`GET /dsh-plugin-tools-panel/state?sessionId=<id>` →
```jsonc
{ "ok": true, "state": {
  "protocol": 10, "sessionId": "…",
  "tools": ["bash", "…"],          // 本会话可见（含已禁用、已披露隐藏），已排序
  "denied": ["write"],             // 全局生效的禁用集合（写盘，重启还在）
  "groups": [{
    "id": "g1", "name": "编辑", "members": ["write", "edit"],
    "disclosure": true,            // 该组是否启用渐进式披露
    "prompt": "用于改文件…"         // 注入系统提示词的分组描述提示词
  }],
  "deferred": ["bash"],            // 本会话被披露隐藏、尚未加载的工具名
  "unlocked": ["g1"],              // 本会话已加载的组 id（会话级，不落盘）
  "masked": 37,                    // 隐藏名里真的从注册表投影消失的个数
  "scopes": 7,                     // 挂上了几条作用域限制（每条 = 一个 live agent）
  "unmaskable": ["spawn_teammate"],// 宿主拒绝遮的名字（agent 本层注册，只能靠 guard）
  "scopesError": "…",              // 上一次挂载失败/受限的原因（没有就省略）
  "blocked": 0, "last": null       // guard 兜底计数与最后一次拦截
}}
```

`POST` body 为 `{ sessionId, deny?: string[], groups?: { id?, name, members, disclosure?, prompt? }[], hide?: string[] }`，
**整表替换**，各字段可同时写。`hide` 是本会话的「卸载」：把列出的组 id 从已加载集合里去掉。
必须带 `x-dsh-plugin-tools-panel` 请求头——跨源页面可以不带预检地发简单请求，要求自定义头才逼出
预检、让浏览器拦下它。`deny` / `hide` 非数组 → `400`；三个字段都没有 → `409`。

### 技能与提示词接口（协议 8）

`GET /dsh-plugin-tools-panel/skills?sessionId=<id>` →
```jsonc
{ "ok": true, "state": {
  "protocol": 10, "sessionId": "…", "available": true, "complete": true,
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
  "protocol": 10, "sessionId": "…", "available": true, "disabled": ["workspace"],
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
`{ sessionId, reset: true }`。关掉一段会把该段名加入禁用集合（装配期从 `sections` 删掉），然后
**重新装配验证**；验证不过（段落遮不住、或关掉后提示词为空）就回滚并回 `409`，`applied` 只在
真生效时为 `true`。同样要求该请求头。

`scopes` 是"隐藏挂上了几个作用域"，`masked` 是"隐藏名里真的从注册表投影里看不见了几个"，
`unmaskable` 是"宿主拒绝遮、只能靠 guard 的名字"。被成功隐藏的工具根本到不了 guard，所以
`blocked` 不为零就说明有东西只能靠兜底拦住——这几个数字是排查时读一次 JSON 就能定位的证据，
界面上不显示。

## 自检

```bash
node test/check.mjs
```

435 条断言，覆盖：清单与 patch、两个半边都不引入外部包（`node:` 内置模块除外，本包用
`link:` 安装）、逐工具判定、全局禁用集合的规范化与落盘（含重启后仍生效）、分组规范化与落盘、请求体清洗、真实 `node:http` 服务器跑
通的整条链路（缺头 403、`deny` / `hide` 非数组 400、三字段全无 409、未知工具名不炸整份限制、晚注册
工具在下一次策略变更时补遮），以及用**伪 React 渲染器**跑通的界面：一个触发器、四个 tab、tab 记忆、
四个 tab 都保持挂载、插件 Remote 调用、过滤未安装运行时、插件搜索与空结果、收藏置顶持久化、
没有插件管理器时面板仍然打开、技能行与开关（文件型与运行时型走同一条作用域影子）、技能关掉后
两条调用路径都断、关掉时不改写技能文件、文件自带禁用键时「开」会清掉那一行、开关集合落盘、
提示词段落列出与开关、
空段落遮蔽、无法遮蔽时的回滚、唯一段落拒绝、全部恢复。

技能/提示词一组还单独覆盖了 frontmatter 补丁（新增 key、翻转、CRLF、BOM、缩进同名项、
未闭合拒绝）、禁用集合的规范化与落盘、服务缺席与会话未启动时的回答，以及 `409` 失败后
**磁盘与内存都不留下**一个假开关。

渐进式披露单独一组：组字段的规范化与提示词边界、挂载后**注册表投影**里真的少了这些 schema、
面板仍保留它们的行、索引段落的逐会话文本（组名 + 描述 + 成员数，**不含工具名**）、`get_tools`
的目录/加载/重复加载、**加载当刻就重挂掩码**（少了这一步，工具会从模型清单里永久消失）、另一个
会话仍锁着且掩码还在、子 agent 继承父会话的加载、手动卸载（`hide`）后掩码重新挂上、关闭披露后
`get_tools` 注销，以及索引段落是**函数**（同一注册对不同会话给出不同答案）而不是一段冻结的
字符串。

其中 `layers:` / `scope-local:` 两组是隐藏机制边界的回归测试：伪宿主把工具分到**预设层**、
**agent 本层**和**全局层**，断言预设层与全局层的名字能从模型可见列表里消失，而 agent 本层的
名字**删不掉**——它们留在 `schemas(agent)` 里、目录过滤和 guard 仍然生效，快照的 `unmaskable`
如实报告。

测试把 `DSH_HOME` 指向临时目录再导入模块，绝不碰真实 profile；跑完删掉。
