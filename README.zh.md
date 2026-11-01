# dsh-plugin-manager-plus

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 增强版插件管理器——浏览社区目录、区分官方/第三方插件、管理插件生命周期、通过 GitHub 同步插件环境。基于 [dsh-market](https://github.com/dsh-market/dsh-market)（MIT）fork 增强。

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/dsh-plugin-manager-plus)](https://www.npmjs.com/package/dsh-plugin-manager-plus)
[![stars](https://img.shields.io/github/stars/cdllang/dsh-plugin-manager-plus?style=flat)](https://github.com/cdllang/dsh-plugin-manager-plus)

打开设置 → **插件管理** → 浏览、安装、管理、同步。

## 安装

```sh
dsh plugin --profile web add dsh-plugin-manager-plus
```

重启 `dsh web`，打开 **设置 → 插件管理**。

## 功能

### 浏览与安装社区插件

- **发现**——可搜索、分页的社区目录（750+ 插件，每天在涨），分类筛选、star 数、中英双语描述
- **一键安装**——确认来源，实时进度；多数插件刷新页面即可用，无需重启
- **官方/第三方徽标**——每个插件自动分类：官方（来自 `deepseek-ai` / `dsh-external` 组织，或 `@deepseek-ai/*` 前缀）显示蓝色 **官方** 徽标，其余为社区。点击插件名或版本号即可跳转对应 GitHub 仓库。

### 管理已安装插件

- **已安装**——带激活状态（已生效/需重启/未生效/损坏/缺失）、版本、来源的分组视图
- **更新**——逐插件检测（npm 版本或锁定 commit vs HEAD），一键更新或全部更新
- **来源版本对比**——npm 显示已安装/最新版本；GitHub 安装显示已安装/最新 SHA、GitHub Compare 返回的准确落后提交数，并提供单次提交和完整比较链接。历史分叉时额外显示本地独有提交数；API 查询失败时显示未知，不猜测数量。更新检查缓存 30 分钟，更新仍需手动触发。
- **启用/停用**——不卸载即可开关插件（通过 `dsh.market.disabled` 持久化）
- **卸载**——两步确认防误触；本次会话装的即点即卸
- **本地插件标识**——没有 GitHub 来源的插件显示灰色 **本地** 徽标与来源（如 `bundles:`、`patch:`）；manifest 里声明了 `repository` 字段的插件会自动解析出 GitHub 链接
- **发起新对话寻求帮助**——安装失败时出现按钮，一键生成脱敏的完整求助提示词，复制后粘贴到新会话即可获得诊断与解决方案

### 环境同步（F4）—— 🔒 默认关闭，需显式启用

把已安装的第三方插件清单备份到 GitHub 仓库，换电脑后一键还原。

- **默认关闭**——同步页只显示启用指南，在显式启用前不产生任何网络请求
- **备份**——推送 `dsh-plugins.json`（名称 + 来源 + 锁定 commit）到你的仓库；本地插件会**打包为文件**嵌入清单，可在其他电脑完整还原
- **还原**——拉取清单、展示差异、自动还原本地插件文件，并列出还需从市场安装的在线插件
- **本地插件文件**——无 GitHub/npm 来源的插件以（路径 → base64）打包进清单；体积守卫保证推送不超过 GitHub contents API 上限
- **隐私**——离开本机的只有插件名、版本号与（本地插件的）文件；Token 绝不出现在清单里，同步开关本身也不会被推送
- **失败求助**——备份/还原出错时同样出现「发起新对话寻求帮助」，生成面向配置的提示词（错误码、消息、提示、仓库/分支）

## 配置

### 环境同步配置步骤

1. 准备一个 GitHub 仓库（如 `me/dsh-plugins`），公开或私有均可
2. 生成 Token：GitHub **Settings → Developer settings → Personal access tokens** → 勾选 **repo** 或 **contents:write**
3. 在 **设置 → 插件管理 → 环境同步** 填写 `owner/repo`、分支和 Token，点击 **启用同步**
4. 点击 **测试连接**——绿色即就绪；红色会显示具体原因

> 不带 Token 时 GitHub API 限流为 60 次/小时（偶尔备份足够）；带 Token 提升到 5000 次/小时。Token 仅存于本地配置，绝不上传。

## 速度

只要插件发布了 npm 包（registry 校验其 repository 指回同一仓库，防冒名），安装即走 npm tarball 而非整仓 GitHub 下载——通常秒级；仅 GitHub 分发的插件取决于你到 GitHub 的网络。

## 安全

- 只允许安装 [awesome-dsh-plugin](https://awesome-dsh-plugin.com) 精选列表内的来源，其它一律拒绝
- 构建脚本默认禁止执行（pnpm ≥10）；被拦截的 git 包构建脚本会自动放行并重试一次，逐包授权仍由你显式决定
- 终端/命令行类插件装进网页版前会被明确提醒
- 安装接口只接受同源 POST；插件不会向任何地方上报数据
- 重启接口要求客户端直接来自环回地址（拒绝代理转发请求），并使用原入口、参数、环境和工作目录重新启动 DSH
- 求助提示词在显示前会自动打码所有 Token 形状（`ghp_*`、`github_pat_*`、`Bearer …`）
- 收录 ≠ 背书：插件是第三方代码，请只安装你信任的来源

## 提交你的插件

**这个仓库是管理器应用本身，不是插件目录。** 插件列表来自精选列表 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)——想让你的插件上架，请去**那边**提 PR（列表加一条即可，市场会自动收录，通常一天内生效）。想让自己的插件在「已安装」里显示 GitHub 链接，在它的 `package.json` 里加 `repository` 字段：

```json
"repository": { "type": "git", "url": "git+https://github.com/you/your-plugin.git" }
```

## 开发

```sh
npm install
npm run build       # tsc + tsdown 客户端打包
npm test            # vitest 单元测试（92 个）
npm run typecheck
npm run check       # typecheck + build + 重启冒烟
```

### 项目结构

```
src/
├── index.ts          # 插件入口
├── routes.ts         # HTTP 路由（安装/更新/同步/帮助/…）
├── profile.ts        # profile 文件系统读取 + 启停 + 快照
├── install.ts        # 安装编排、故障恢复、allowBuilds 解析
├── sync.ts           # F4 环境同步（本地插件打包/解包）
├── help-prompt.ts    # 求助提示词生成（安装 / 同步）
├── op-queue.ts       # FIFO 任务队列
├── provenance.ts     # 官方/第三方判定
├── dsh-cli.ts        # dsh CLI 子进程 + 试装验证
└── client/           # React UI（MarketSection、SyncTab、HelpPromptDialog）
```

## 路线图与反馈

- Bug 与建议请提 [issue](https://github.com/cdllang/dsh-plugin-manager-plus/issues)，附上管理器的「导出日志」能让排查快十倍
- 本项目 fork 自 [dsh-market](https://github.com/dsh-market/dsh-market)——上游改进可随时合并回来

## 数据源

实时来自 [awesome-dsh-plugin.com/plugins.json](https://awesome-dsh-plugin.com/plugins.json)——精选条目、npm 映射、star 数由 CI 每日刷新——内置快照做离线兜底。

## 许可

MIT —— fork 自 [dsh-market](https://github.com/dsh-market/dsh-market)（MIT）
