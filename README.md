# IBKR Analytics Studio Offline

IBKR Analytics Studio Offline 是一个面向 Interactive Brokers 账户报表的 Windows 离线桌面应用。当前离线版主推 **IBKR Flex API 自动拉取报表**：应用通过本机 WebView2 原生壳请求 IBKR Flex Web Service，拿到 CSV 报表后在本机解析和展示。

手动上传 CSV/TXT 仍然保留，主要作为备用导入方式。

## 核心定位

- Windows 本地应用，基于 Microsoft Edge WebView2。
- 主推 Flex API 自动拉取 Activity Flex Query。
- 数据解析、图表渲染、JSON/PNG 导出均在本机完成。
- Token 和 Query ID 可记住在本机 WebView2 本地存储中。
- 不需要自建服务器，不把报表上传到第三方服务。

## 快速开始

推荐直接运行已发布的 WebView2 版本：
https://github.com/G061206/IBKRAnalyticsStudio/releases
下载压缩包解压后运行exe

```text
IBKRAnalyticsStudio.exe
```

打开后，参考首页教程获取 **IBKR Flex API** ：

- Flex Web Service Token
- Activity Flex Query ID

填写后点击 **Fetch report** ，应用会自动向 IBKR 拉取报表并解析。

### Token 保存

应用会记住上次输入的 Token 和 Query ID，保存位置是当前机器的 WebView2 本地存储，可点击 **Forget saved** 清除。

Token 是敏感信息。若曾经发给他人或暴露在聊天记录中，建议在 IBKR Client Portal 重新生成。

### 报表暂存与刷新

通过 Flex API 拉取成功后，应用会把最近一次报表暂存在本机 WebView2 IndexedDB。下次打开软件时会先展示暂存报表，避免每次启动都等待 IBKR 重新生成报表。

- 暂存内容只保存在当前电脑。
- 页面顶部会显示报表更新时间。
- 打开暂存报表后，应用会继续尝试刷新报表。
- 刷新状态使用“报表刷新中”“报表已更新”等提示。
- 手动选择本地 CSV/TXT 时，不会覆盖 Flex API 的暂存报表。

## 推荐 Flex Query 配置

进入 IBKR Client Portal：

```text
Performance & Reports -> Flex Queries -> Activity Flex Query
```

### 字段选择规则

需要逐个点击下面的 Section。每点一个 Section，IBKR 都会弹出字段选择窗口：

- 大多数 Section：顶部 `Level/Options` 尽量全选，下方字段列表点击 `Select All`。
- `Transaction Fees`：只需要选择 `Summary`、`Detail`、`Execution` 三项。
- `Change in NAV`：选择 `Realized & Unrealized`。

### 必选 Sections

- Account Information
- Net Asset Value (NAV) in Base
- Cash Transactions
- Change in NAV
- Change in Dividend Accruals
- Open Positions
- Trades
- Realized and Unrealized Performance Summary in Base
- Forex P/L Details
- Interest Details (Tiers)
- Commission Details
- Transaction Fees
- Mark-to-Market Performance Summary in Base
- Forex Balances

### 其它设置

- Format: `CSV`
- Include header and trailer records?: `Yes`
- Include column headers?: `Yes`
- Display single column header row?: `No`
- Include section code and line descriptor?: `Yes`
- Period: `Last 365 Calendar Days`
- Date Format: `yyyy-MM-dd`
- Time Format: `HHmmss`
- Date/Time Separator: `,`
- Profit and Loss: `Default`
- Include Offsetting Trade/Cancel Pairs?: `No`
- Include Currency Rates?: `Yes`
- Include Audit Trail Fields?: `No`
- Display Account Alias in Place of Account ID?: `No`
- Breakout by Day?: `Yes`

单次 Flex Web Service 请求建议控制在 365 天以内。更久历史数据后续应通过分段同步实现。

### Change in NAV

为了绘制剔除入金/出金影响的收益率曲线，必须打开：

```text
Breakout by Day? -> Yes
```

这样 `CNAV / Change in NAV` 会按天返回，每天包含 `TWR`。应用会使用每日 TWR 累乘生成收益率曲线，而不是用 NAV 简单相除。

总览页的“时间加权收益”也会优先使用每日 TWR 的最后一个累计值；如果报表没有逐日 TWR，才回退到 `Net Asset Value` 汇总区块里的 `Time Weighted Rate of Return`。

### Dividends

持仓表的“股息”列会按标的汇总已支付股息，并在没有现金股息记录时显示股息应计净额。Flex Query 需要包含 `Cash Transactions` 和 `Change in Dividend Accruals`。在 `Cash Transactions` 里选择 Dividends / Payment in Lieu of Dividends 相关字段；如果只配置了持仓和交易区块，这一列会显示为 0。

### S&P 500 基准叠加

收益率曲线会尝试叠加同期 S&P 500 收益率，帮助对比账户表现和市场基准。

- 组合收益率：按 IBKR 每日 TWR 累乘，正收益为绿色，负收益为红色。
- S&P 500：统一显示为紫色细线。
- 基准数据来自 Cloudflare Worker 代理的 FRED `SP500` 序列。
- 若 Worker 未部署、CORS 未放行或数据暂不可用，页面会继续显示账户曲线，不阻塞本地报表查看。

### Open Positions

建议保留 Summary 和 Lot 字段。应用会优先使用 `SUMMARY` 层级，避免 Summary 和 Lot 重复加总。

### Trades

建议包含 Order 和 Execution。应用交易流水默认使用 `LevelOfDetail = ORDER`，避免同一订单因多笔 execution、closed lot、summary 重复显示。

### Realized and Unrealized P/L

如果开启 `Breakout by Day`，IBKR 会把 FIFO/P&L 也按天展开。应用的处理规则是：

- 已实现盈亏：按整个报表周期累计。
- 未实现盈亏：取最新报表日的期末快照。
- 总盈亏：累计已实现 + 最新未实现。
- 主要贡献者：按 ticker 累计已实现盈亏。

这个规则避免把每日未实现盈亏快照重复累加。

## 页面功能

### 总览

- 期末净值
- 现金
- 总盈亏
- IBKR TWR
- 交易订单数量
- 当前持仓
- 佣金费用
- 资产配置
- 币种敞口
- 剔除入金影响的收益率曲线
- 资产配置占比

### 持仓

- 当前 Open Positions
- 按资产类别汇总
- 按多空方向汇总
- 按币种汇总
- 按标的市值展示持仓分布

### 收益

- 已实现盈亏
- 未实现盈亏
- 总盈亏
- 股票/期权/外汇分类盈亏
- 主要贡献者
- 月度收入与支出
- 已实现交易排行

### 每日

- 每日交易统计
- 交易日历
- 日交易笔数
- 月度交易流水

### 数据

- 已解析区块
- 汇率数据
- 解析诊断

## 手动导入模式

如果暂时不使用 Flex API，也可以手动导入 IBKR Activity Statement CSV/TXT：

- 拖放 CSV/TXT 文件
- 选择文件
- 粘贴 CSV 文本
- 加载示例数据

手动导入适合：

- 验证历史旧报表
- 导入超过 Flex API 单次范围的年度文件
- 排查 Flex Query 字段配置

## 本地开发

静态前端可通过本地服务预览：

```powershell
npm run serve
```

默认地址：

```text
http://127.0.0.1:4187/
```

语法检查：

```powershell
npm run check
```

## S&P 500 Worker

S&P 500 基准数据代理位于：

```text
cloudflare\sp500-proxy
```

Worker 会把 FRED `SP500` 收盘价缓存到 Cloudflare KV，普通查询只读取 KV：

```text
https://sp500-proxy.3368517784.workers.dev/?start=2025-12-24&end=2026-06-02
```

部署前需要在 `wrangler.toml` 中替换真实 KV namespace id，并在 Cloudflare 中配置：

- `SP500_KV`: KV namespace 绑定。
- `FRED_API_KEY`: FRED API key。
- `SYNC_SECRET`: 手动同步接口密钥。

手动同步接口受密钥保护：

```text
GET /admin/sync?key=<SYNC_SECRET>
```

WebView2 桌面端使用 `https://ibkr-analytics.local` 加载页面，Worker 的 CORS 白名单需要包含这个 origin，否则前端会拿不到 S&P 500 叠加线。

## 构建 Windows 应用

WebView2 壳位于：

```text
windows\IBKRAnalyticsStudio.WebView2
```

发布框架依赖版本：

```powershell
cd windows\IBKRAnalyticsStudio.WebView2
.\build.ps1
```

发布自包含版本：

```powershell
.\build.ps1 -SelfContained
```

发布干净便携版本：

```powershell
.\build.ps1 -SingleFile
```

框架依赖版本体积更小，但目标机器需要 .NET Desktop Runtime。自包含版本更大，但更适合分发给没有 .NET 环境的机器。干净便携版本会把 .NET/WebView2 依赖收进单个 exe，解压后根目录只包含 `IBKRAnalyticsStudio.exe` 和 `wwwroot` 文件夹。

## 目录结构

```text
ibkr-analytics-studio-offline/
├─ assets/
│  ├─ app-logo.png
│  ├─ app-logo-256.png
│  ├─ ibkr-logo.svg
│  ├─ icon.svg
│  └─ styles.css
├─ cloudflare/
│  └─ sp500-proxy/
├─ docs/
├─ samples/
├─ src/
│  ├─ app.js
│  ├─ encoding.js
│  ├─ parser.js
│  └─ reportLanguage.js
├─ windows/
│  └─ IBKRAnalyticsStudio.WebView2/
├─ index.html
├─ package.json
├─ serve.mjs
└─ README.md
```

## 核心文件

- `src/parser.js`: IBKR CSV/Flex CSV 解析、盈亏、持仓、交易、NAV、TWR 数据处理。
- `src/app.js`: 页面渲染、交互、Flex API 面板、报表暂存、S&P 500 基准叠加、JSON/PNG 导出。
- `assets/styles.css`: 页面样式、深色主题、响应式布局。
- `cloudflare/sp500-proxy/index.js`: S&P 500/FRED 数据代理、KV 缓存、定时同步和手动同步接口。
- `windows/IBKRAnalyticsStudio.WebView2/MainForm.cs`: Windows WebView2 壳、Flex API 原生桥接、窗口主题。
- `windows/IBKRAnalyticsStudio.WebView2/FlexApiClient.cs`: IBKR Flex Web Service 请求逻辑。
- `docs/sp500-benchmark-implementation.md`: S&P 500 基准叠加实现记录。

## 隐私与安全

- CSV 报表解析在本机完成。
- Flex API 请求只发送到 IBKR 官方 Flex Web Service。
- Token 和 Query ID 只保存在本机 WebView2 localStorage。
- S&P 500 基准请求只发送日期范围，不发送账户、持仓、交易或 NAV 数据。
- JSON/PNG 只有用户主动点击时才生成。
- 不建议把真实报表、Token、账号明文提交到公开仓库或聊天记录。

## 已知限制

- 当前重点支持英文 IBKR Activity/Flex CSV。
- XML Flex 报表暂未作为主路径支持。
- Flex Web Service 单次历史范围有限，更久历史建议后续做分段同步。
- 不同账户权限和 Flex Query 字段配置会影响可解析数据。
- 页面统计用于个人复盘和数据查看，不构成投资、税务或会计建议。

## 免责声明

本项目不是 Interactive Brokers 官方产品，也不与 Interactive Brokers LLC 存在官方关联。所有商标和产品名称归其各自所有者所有。

请以 IBKR 官方报表为准，自行核对所有投资、税务和会计相关数据。
