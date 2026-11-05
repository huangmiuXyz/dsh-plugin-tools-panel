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

1. **隐藏（主）**——`ctx.tools.restrict({ deny })` 把它从模型可见的 schema 列表里摘掉。
   模型看不到就不会调它，顺带省下每个请求的 schema 体积。`restrict()` 只能按作用域生效
   （宿主拒绝无作用域的全局限制），所以给每个 agent 的 `agent.ctx` **以及它上面的每一层
   作用域**（预设自己那一层）各挂一个极小插件来注册。
2. **拦截（兜底）**——`ctx.tools.guard()` 每次调用重新解析该会话的禁用集合。作用域内注册的
   工具 `restrict()` 遮不住，这类由 guard 拦，回执：

```
此操作已被用户实时禁用：工具「write」未执行，且不要再尝试调用。This tool is disabled live
by the user: "write" was not executed. Do not retry it — continue with what the user allows,
or tell the user what you need.
```

### 为什么要往上游作用域也挂一层（曾经的 bug）

工具注册表是「全局层 + 各层作用域」合并的，`restrict()` 只遮**继承来的**贡献，不遮本层
自己注册的。而 `preset-standard` 的插件行（`tool-bash`、`tool-fs`、`tool-fs-search`…）
是注册进**预设自己的作用域**的——那是 agent 的祖先层。所以只在 `agent.ctx` 上施加掩码，
`bash`/`read`/`write` 这些预设工具**根本遮不掉**：开关显示为关，模型照旧看得见、照旧能调
（只是每次调用被 guard 拦下并回一条"不要再试"）。

现在按 agent 的作用域链**逐层往上挂**：agent 自己一层，加上它上面每一层（预设那一层、
以及更上的宿主层）。链是通过 Cordis 的 `parent` 链接走出来的，所以代码不需要知道"预设"
是什么——谁把工具给了这个 agent，同一遍walk 就找到谁。上层按自己的身份只挂一次，多个
agent 共用同一个预设不会重复挂。

判断有没有修好的证据是 `masked`：它数的是"禁用名里真的从模型视图里消失了的个数"。修复前
`masked` 恒为 0（预设工具一个都没遮住），修复后应等于被禁用的预设工具数。

### 为什么 `agents` 服务要每次重新取（另一个 bug）

每一半功能（隐藏、继承、技能影子、提示词影子）都要先找到"这个会话的活 agent"。以前是在
`apply()` 里 `const agents = ctx.get('agents')` 取一次存下来——**启动时这几乎总是
`undefined`**：profile 的 bundles 并发加载，Cordis 的 `ctx.get(name, strict)` 对"提供方 fiber
尚未激活"的服务返回 `undefined`，而这个插件的行经常比 agent loop 先挂上。后果是静默的，并且
只打击"按 agent 生效"的部分：

- `restrict()` 一次都没挂（`scopes: 0`、`masked: 0`）：渐进披露只在系统提示词里写了"这些组还
  没加载"，组内工具其实全都在模型的工具列表里；kill switch 也退化成只剩 guard 兜底。
- 技能/提示词 tab 一律回 `no-live-agent`，哪怕会话正在跑。

现在：`agents` 一律**按需取**（`agentsNow()`）；生命周期监听器**不等服务**就注册（`agent/created`
的 payload 自带 agent，足够挂载）；服务晚到时再跑一遍 catch-up，补上"挂载前就已存在"的 agent；
tab 侧在服务缺席时退回**事件里见过的 agent**（`seenAgents`）。`scopes` / `masked` 就是这件事的
读数：重启后 `scopes` 应从 1 起算，`masked` 应等于被披露隐藏且真被遮住的工具数。

界面：可搜索、可滚动，每行只有工具名和一个开关（不写说明文字，省一屏的行数），搜索框按
名字过滤。

**手动分组**：点「创建分组」进入多选，勾好工具后点「建组」命名；「取消创建」退出多选。
一个组在清单里是一行，带展开箭头、成员数和**组总开关**。组只是视图 + 批量操作，没有自己
的策略：组开关是从成员的禁用状态**算出来的**，所以组和工具不可能矛盾。一个工具可以同时在多个组里；被组收走的工具不再出现在下面的扁平
列表，所以组是容器不是过滤器。组可重命名、可删除，删组不动任何开关。

**分组定义写盘**（`$DSH_HOME/dsh-plugin-tools-panel/groups.json`），重启还在；**禁用状态只在
内存**，重启恢复全开。两者刻意不同：前者是你对自己工具列表的整理，后者是一次性刹车。

**渐进式披露**：组标题右边有一个「渐进披露」按钮，点开是弹窗，填两样——是否开启，以及
**分组描述提示词**（这句话是写给模型看的，不是给人看的备注）。开启了披露的组，名字后面会挂
一个**徽标**「渐进披露」，一眼就能和普通分组区分开；本会话加载过之后，同一个徽标变成绿色的
「渐进·已加载」。开启后：

- 组内工具**不再注入上下文**——和"禁用"走同一条隐藏路径（`restrict()`），模型看不到它们的
  schema，也不再为它们付 token；但它**不拦调用**：已经拿到 schema 的模型照样能调。披露管的是
  上下文成本，不是权限。
- 系统提示词里多一段索引（段落名 `tools-panel:deferred-tools`，`text` 是每次装配求值的函数，
  所以每个会话只看到自己还没加载的组）：组名 + 你的描述提示词 + 成员数，**不列工具名**。
- 只要存在至少一个这样的组，就自动注册工具 `get_tools`（没有披露组时它不存在）。不带参数先
  列目录（组名、成员数、是否已加载）；带 `group`（组名或 id）就是**加载**这组。
- `get_tools` 的返回**只有一句确认**（"已注入 N 个工具，从下一步起可用"），**不返回任何工具名、
  说明或参数 schema**：工具本身下一步就会带着真实 schema 出现在工具列表里，在这里再抄一遍等于
  让模型把同一份 schema 读两遍，正好白费这个功能要省的上下文。
- **加载即在本会话内解锁**：下一轮这些工具重新出现在工具列表里。解锁是**会话级、只在内存**
  ——新会话或重启 DSH 都回到未加载。
- **手动卸载**：加载过的组在组行上多一个「卸载」按钮（旁边的绿色徽标「渐进·已加载」只是
  状态），点一下就把这组工具从本会话重新隐藏；弹窗里也有同一个动作。两个入口走同一条写路径
  （`hide`），只改本会话的已解锁集合，**不动分组定义**，所以组仍处于披露状态、模型以后还能
  再用 `get_tools` 加载它。
- 禁用与披露叠加，互不覆盖：被禁用的工具加载后仍然是禁用状态。
- 定义（含是否披露、描述提示词）照旧写进 `groups.json`，跨会话保留。
- **模型也能配置**：`manage_tool_groups` 的 `set_disclosure` 动作（`group` + `disclosure` 和/或
  `prompt`，两者都可省略一个）改的就是弹窗里同样两个字段，写入即生效并重新派生隐藏集与
  `get_tools` 的注册状态。

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

- 关掉一段 = 在**该 agent 的作用域**里注册一个**同名的空段落**。段落按作用域分层合并，
  最近的一层覆盖祖先层；空段落会被渲染器丢掉，所以净效果就是"这一段不再进入系统提示词"。
  不碰任何插件的源码或数据文件，升级插件不会被覆盖。
- 改动**全局生效、重启还在**（`$DSH_HOME/dsh-plugin-tools-panel/prompts.json`），下一条消息
  生效——agent loop 每一步都重新装配系统提示词。
- 宿主会当场**验证**：重新装配后这段的文本真的变成 0 才回 `applied`；如果这段是 agent 自己
  注册的、空段落遮不住，或者它是当前唯一的段落（关掉提示词就空了），宿主回滚并回 `409`
  说明原因，面板把拒绝原因显示出来。
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

禁用集合属于一个会话，并**向下继承**：主会话禁用后，它派生的全部子会话（`subagent`、
`workflow` 里的 `agent()`，以及更深层）一起被拦；否则"派个子 agent 去干"就是一步绕过。
继承是调用时沿父链**惰性解析**的，所以在子 agent 已经存在之后再限制父会话也照样生效，
放开父会话则一次性放开所有没有自己策略的后代。从子会话里改，改的是它所属主会话的策略，
界面会写"继承自主会话"。

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
"宿主端还是旧版本，请重启 DSH"；宿主收到 `deny`、`groups`、`hide` 都没有的请求返回 `409`。
改字段名或状态形状时**两边一起加一**，自检里有一条断言盯着这个数字是否一致。当前：`10`
（跳过 9：线上曾有一个协议 9 的旧版本线用的是完全不同的状态形状）。

## 接口

`GET /dsh-plugin-tools-panel/state?sessionId=<id>` →
```jsonc
{ "ok": true, "state": {
  "protocol": 10, "sessionId": "…", "ownerId": "…", "inherited": false,
  "tools": ["bash", "…"],          // 本会话可见（含已禁用、已披露隐藏），已排序
  "denied": ["write"],             // 当前生效的禁用集合
  "groups": [{
    "id": "g1", "name": "编辑", "members": ["write", "edit"],
    "disclosure": true,            // 该组是否启用渐进式披露
    "prompt": "用于改文件…"         // 注入系统提示词的分组描述提示词
  }],
  "deferred": ["bash"],            // 本会话被披露隐藏、尚未加载的工具名
  "unlocked": ["g1"],              // 本会话已加载的组 id（会话级，不落盘）
  "scopes": 4,                     // 挂了限制的 agent 作用域数
  "masked": 1,                     // 真的从模型视图里消失的禁用名个数
  "blocked": 0, "last": null       // guard 兜底计数与最后一次拦截
}}
```

`POST` body 为 `{ sessionId, deny?: string[], groups?: { id?, name, members, disclosure?, prompt? }[], hide?: string[] }`，
**整表替换**，各字段可同时写。`hide` 是本会话的「卸载」：把列出的组 id 从已解锁集合里去掉。
必须带 `x-dsh-plugin-tools-panel` 请求头——跨源页面可以不带预检地发简单请求，要求自定义头才
逼出预检、让浏览器拦下它。`deny` / `hide` 非数组 → `400`；三个字段都没有 → `409`。

### 技能与提示词接口（协议 8 起）

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

466 条断言，覆盖：清单与 patch、两个半边都不引入外部包（`node:` 内置模块除外，本包用
`link:` 安装）、逐工具判定、继承、分组规范化与落盘、请求体清洗、真实 `node:http` 服务器跑
通的整条链路（缺头 403、`deny` 非数组 400、两字段全无 409、未知工具名不炸整份限制、晚注册
工具也会被隐藏），以及用**伪 React 渲染器**跑通的界面：一个触发器、四个 tab、tab 记忆、
四个 tab 都保持挂载、插件 Remote 调用、过滤未安装运行时、插件搜索与空结果、收藏置顶持久化、
没有插件管理器时面板仍然打开、技能行与开关（文件型与运行时型走同一条作用域影子）、技能关掉后
两条调用路径都断、关掉时不改写技能文件、文件自带禁用键时「开」会清掉那一行、开关集合落盘、
提示词段落列出与开关、空段落遮蔽、无法遮蔽时的回滚、唯一段落拒绝、全部恢复。

渐进式披露单独一组：索引段落的逐会话文本、`get_tools` 的目录/加载/重复加载、加载后工具重新
可见、**组行徽标**（未加载是「渐进披露」，加载后同一个徽标变成「渐进·已加载」，卸载后回到
前者；披露没开的组没有徽标）、**手动卸载**（组行按钮与弹窗走同一条 `hide` 写路径，只改本会话
的已解锁集合）、披露关掉后 `get_tools` 注销、以及「一次传递不能清掉自己刚施加的掩码」的振荡
回归测试。

技能/提示词一组还单独覆盖了 frontmatter 补丁（新增 key、翻转、CRLF、BOM、缩进同名项、
未闭合拒绝）、禁用集合的规范化与落盘、服务缺席与会话未启动时的回答，以及 `409` 失败后
**磁盘与内存都不留下**一个假开关。

其中 `layers:` 一组是上面那个 bug 的回归测试：伪宿主把工具分到**预设层**和**全局层**两层
（和真实宿主一致），断言禁用预设工具时它真的从该 agent 的可见列表里消失、掩码确实施在了
预设层、且只施一次、放开后两层都恢复。

`late agents:` 一组是"agents 服务晚到"那个 bug 的回归测试：伪 ctx 在 `apply()` 时还没有
`agents`，断言监听器照样注册、单靠 `agent/created` 的 payload 就能把披露掩码挂上、服务晚到后
的 catch-up 能补挂已存在的 agent，并且技能/提示词 tab 在服务缺席时仍认得事件里见过的 agent。

测试把 `DSH_HOME` 指向临时目录再导入模块，绝不碰真实 profile；跑完删掉。
