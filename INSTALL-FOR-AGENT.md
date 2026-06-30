# boss-recruit · 给 AI 助手执行的安装手册

> 把本文件完整发给你的 AI 编码助手（Claude Code / Codex / Cursor / Cline 等），它会照着帮你装好、配好、跑起来。
> 助手：你正在帮用户安装并运行 boss-recruit（BOSS 直聘新招呼收件箱自动化，附件简历同步飞书）。**严格按下面顺序执行，遇到需要用户提供信息或需要授权的地方先停下来问用户。**

---

## AGENT EXECUTION PLAN

### 步骤 0 · 环境前置检查

依次运行，任一不满足就停下来告诉用户怎么补：

```bash
node --version          # 必须 >= 20，否则让用户先升级 Node
opencli --version 2>/dev/null || echo "NEED_OPENCLI"
```

若输出 `NEED_OPENCLI`，运行：

```bash
npm install -g @jackwener/opencli
```

### 步骤 1 · 安装 skill 与配套适配器

```bash
git clone https://github.com/casperkwok/boss-recruit ~/.claude/skills/boss-recruit
mkdir -p ~/.opencli/clis/boss
cp ~/.claude/skills/boss-recruit/adapters/boss/attachment.js ~/.opencli/clis/boss/
```

### 步骤 2 · 浏览器扩展（必须用户手动，不能自动化）

告诉用户二选一安装 OpenCLI Browser Bridge 扩展，**不要尝试自动安装**：

- Chrome 应用商店：https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk
- 或手动：到 https://github.com/jackwener/opencli/releases 下载 `opencli-extension-v*.zip`，解压后在 `chrome://extensions` 开「开发者模式」→「加载已解压的扩展程序」选该文件夹。

然后让用户在**同一个 Chrome 里登录 BOSS 直聘招聘端账号**。完成后运行检查，必须三项全 OK：

```bash
opencli doctor
```

若 `Extension: not connected`，让用户确认扩展已装且 Chrome 开着，可 `opencli daemon restart` 后重试。**此步不通过不要继续。**

### 步骤 3 · 配置飞书目标表（需向用户索要两样东西）

向用户索取：

1. **飞书多维表格的 `/base/` 链接**（必须 `/base/` 个人端，不支持 `/wiki/` 企业端）。
   推荐用现成模板：让用户打开「小良知聘 · 人才库模板」https://pixelbit.feishu.cn/base/T0q4bV9m8aEEJfsmornc053Xnpe?table=tblyYqSydskSv6mz&view=vewqRMCg2L → 右上角「使用模板/创建副本」存到自己飞书 → 复制副本的 `/base/` 链接。
2. **授权码**：让用户在该多维表格「···更多 → 高级权限 → 获取授权码」生成，形如 `pt-xxxx`。

拿到后运行（把占位符换成用户给的值）：

```bash
node ~/.claude/skills/boss-recruit/scenarios/setup.mjs "<用户的/base/链接>" --token "<pt-授权码>"
```

看到「已配置目标表」并列出表名/字段即成功。**授权码是敏感凭证，不要写进任何提交、日志或对用户复述全文。**

### 步骤 4 · 试运行（安全模式，无对外动作）

确认用户的 Chrome 当前在已登录的 BOSS 招聘端页面，然后：

```bash
node ~/.claude/skills/boss-recruit/scenarios/inbox.mjs --limit 5
```

读输出的汇报，把"处理了几人、同步了几份附件简历"讲给用户。这一步只读+同步，不发任何消息。

---

## AGENT 运行规则（务必遵守）

- **默认安全模式**：`inbox.mjs` 不加 `--live` 时，"要简历"只演示不真发。日常调用默认就用安全模式。
- **`--live` 是对外、不可撤回动作**：只有用户**明确要求真发**时才加 `--live`，且首次务必 `--limit 2~3`，并把每条将发送的话术先给用户确认。**绝不擅自加 `--live`。**
- **熔断要如实转达**：脚本遇到验证码/登录失效/沟通次数耗尽会自动暂停并打印暂停原因，照实告诉用户该怎么处理，不要绕过去重试。
- **凭证保密**：授权码、登录态等不写进提交/日志/对外消息。

## 自然语言触发（装好后日常用）

用户对你说这些，你执行对应命令：

| 用户说 | 你执行 |
|--------|--------|
| 处理一下 BOSS 新招呼 / 同步新招呼的附件简历 | `node ~/.claude/skills/boss-recruit/scenarios/inbox.mjs --limit 10` |
| 给没给简历的发消息要简历，先演示别真发 | 同上（默认就是演示） |
| 确认没问题，真发给前 N 个 | `node ~/.claude/skills/boss-recruit/scenarios/inbox.mjs --live --limit N`（先复述话术请用户确认） |
| 重新扫一遍处理过的 | 加 `--force` |
| 查当前配置 | `node ~/.claude/skills/boss-recruit/scenarios/setup.mjs --show` |

## 它会做什么（一句话）

附件优先：逐个候选人 → 有附件简历就零弹窗下载 PDF 并同步到飞书人才表（通过初筛）；没附件就读其在线简历当上下文、发消息要简历（默认演示）。全程随机延时、风控熔断、防发错人。

## 故障速查

| 现象 | 处理 |
|------|------|
| `opencli doctor` 扩展未连 | 确认扩展已装、Chrome 开着；`opencli daemon restart` |
| 授权码无效/过期 | 让用户重新「获取授权码」，重跑步骤 3 |
| 跑到一半暂停提示验证码/次数用完 | 处理掉提示的问题，重跑即可，已处理的不会重复 |
| 提示 wiki 链接不支持 | 必须用 `/base/` 链接（个人端），不能用 `/wiki/` |

> 完整说明见仓库 README：https://github.com/casperkwok/boss-recruit ，使用前阅读 DISCLAIMER.md，账号与合规风险自负。
