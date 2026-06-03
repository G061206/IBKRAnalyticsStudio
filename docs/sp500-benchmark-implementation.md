# S&P 500 Benchmark Overlay — 实现记录

> 会话日期：2026-06-03
> 
> 目标：在 IBKR Analytics Studio 收益率曲线模块中，叠加同期 S&P 500 行情作为基准对比。

---

## 对话记录

### 1. 需求讨论：有哪些实现方法？

用户希望在收益率曲线模块拉取同期 S&P 500 行情，叠加到自己的历史收益率上。

提出了 3 种方案：
- **方案 1**：静态嵌入 S&P 500 历史数据（离线可用，需手动更新）
- **方案 2**：WebView2 原生桥接实时行情 API（依赖网络和第三方）
- **方案 3**：Python yfinance 预拉取（多了 Python 依赖）

### 2. yfinance 的可行性

用户提到软件有几百用户。分析了 yfinance 的问题：
- 每个用户需要装 Python + yfinance，部署成本高
- Yahoo Finance 非官方 API，随时可能挂
- 不适合分发给终端用户

建议了两个替代方案：
- **方案 A**：前端直接调免费行情 API（Alpha Vantage / Twelve Data）
- **方案 B**：自建 Cloudflare Worker 做代理缓存

### 3. 选定方案 B + Cloudflare Worker

用户选择方案 B。Worker 架构：
```
FRED API ← 每天 1 次 Cron
    ↓
KV (全量 S&P 500 历史)
    ↓
Worker (切片日期段)
    ↓
CDN 缓存 24h → 前端 fetch
```

### 4. 从 Twelve Data 切换到 FRED API

用户询问可否用 FRED API。
- FRED（美联储官方）：免费、120 次/分钟、无需担心限流
- 优于 Twelve Data（800 次/天）
- Worker 改为调用 FRED API

### 5. 优化为 KV 存储 + Cron 定时更新

用户提出：后端存储几年行情，用户按需拉取需要的日期段。
- Cron 每天 22:30 UTC 触发，首次全量回填（1957 年至今），之后增量追加
- Worker 从 KV 读完整数据 → 内存切片日期段 → 返回
- FRED API 一天只调用 1 次，几百用户无压力

### 6. Cloudflare 网页端部署

用户询问能否在网页端操作（不想用命令行）。
- 全部操作可在 Cloudflare Dashboard 完成
- Worker 代码粘贴、KV 绑定、Secret 注入、Cron 设置均支持网页端

### 7. Worker 调试：KV 未绑定导致 Worker 崩溃

用户部署后访问 Worker URL 返回 Transport Error。
- 诊断：KV namespace `SP500_KV` 未绑定导致代码 `env.SP500_KV.get()` 抛异常
- 需在 Settings → Variables → KV Namespace Bindings 添加绑定

---

## 文件变更清单

| 文件 | 操作 | 行数 |
|------|------|------|
| `cloudflare/sp500-proxy/index.js` | 新增 | +173 |
| `cloudflare/sp500-proxy/wrangler.toml` | 新增 | +10 |
| `src/app.js` | 修改 | +110 / −8 |
| `assets/styles.css` | 修改 | +54 |

---

## 一、Cloudflare Worker — `cloudflare/sp500-proxy/`

### `index.js` (173 行)

双入口 Worker：

**`fetch(request, env)`** — 用户请求入口

| 参数 | 说明 |
|------|------|
| `?start=YYYY-MM-DD` | 起始日期 |
| `?end=YYYY-MM-DD` | 结束日期 |

流程：
1. 校验日期参数
2. 从 `env.SP500_KV` 读取 key `sp500` 的全量数据（JSON）
3. 空则返回 503
4. `sliceRange()` 按日期范围切片
5. 返回 `{ symbol: "SPX", dates: [...], closes: [...] }`
6. 响应头 `Cache-Control: max-age=86400`

**`scheduled(event, env)`** — Cron 定时任务

- KV 为空：调用 FRED API 拉取 1957-03-04 至今全部数据，写入 KV
- KV 有数据：拉取 lastDate 至今的增量，Map 去重合并后写回

**辅助函数：**
- `corsHeaders(request)` — CORS 头，允许 `ibkr-analytics.app`、`localhost:4187` 等来源
- `errorResponse(message, status)` — JSON 错误响应
- `isValidDate(str)` — 日期格式校验
- `sliceRange(data, start, end)` — 日期段切片
- `fetchFromFred(start, end, apiKey)` — 调用 FRED API
- `mergeData(existing, incoming)` — Map 去重 + 排序合并

### `wrangler.toml` (10 行)

```toml
name = "sp500-proxy"
main = "index.js"
compatibility_date = "2025-06-01"

[[kv_namespaces]]
binding = "SP500_KV"
id = "YOUR_KV_NAMESPACE_ID"

[triggers]
crons = ["30 22 * * *"]
```

---

## 二、前端 — `src/app.js`

### 新增常量

```js
const SP500_BENCHMARK_URL = "https://sp500-proxy.3368517784.workers.dev";
```
→ 部署后需替换为实际 Worker 地址。

### State 新增字段

```js
benchmark: null  // { dates: [...], closes: [...] }
```

### 新增函数

#### `buildBenchmarkRows(benchmark, portfolioRows)`
- 将 S&P 500 收盘价对齐到用户每个交易日
- 以用户报表第一天为基准（baseClose），计算同期累计收益率
- 找到目标日当日或之前最近交易日对应的 S&P 收盘价（`findClosestClose`）
- 返回 `[{ date, returnRate, close }]`

#### `findClosestClose(benchmark, targetDate)`
- 线性扫描 benchmark.dates，找不晚于 targetDate 的最近一条收盘价，避免使用未来价格

#### `buildBenchmarkPath(benchmarkRows, ...)`
- 生成 S&P 500 的 SVG `<path>` 虚线路径
- 段分正负收益设不同 class

#### `fetchBenchmark(parsed)`
- 异步请求 Worker，URL 参数为报表的日期范围
- 拿到 `{ dates, closes }` 后更新 `state.benchmark`，触发 `renderDashboard()`
- 完全静默失败，不影响主功能

### 修改函数

#### `renderReturnCurve(data, currency, benchmark)` — 新增第三个参数
- Y 轴范围：`allValues = [...portfolioValues, ...benchmarkValues]`，避免 benchmark 线越界
- SVG 渲染顺序：grid → zero-line → **benchmark 虚线** → portfolio 实线
- benchmark 有数据时：图表下方渲染图例栏
  - Portfolio（绿色圆点 + 标签）
  - S&P 500（黑色圆点 + 标签 + 同期收益率数值）

#### `renderOverview(data)` — 传递 benchmark
```js
renderReturnCurve(data, currency, state.benchmark)
```

#### `parseText(...)` — 数据解析成功后触发
```js
fetchBenchmark(parsed);  // async，不阻塞渲染
```

#### `resetReport()` — 清除 benchmark
```js
state.benchmark = null;
```

---

## 三、样式 — `assets/styles.css`

新增 54 行（在原 `.return-curve-note` 与 `.return-curve-unavailable` 之间）：

| 类名 | CSS 说明 |
|------|----------|
| `.return-curve-legend` | flex 横排，gap 16px |
| `.legend-item` | inline flex，12px，灰色 |
| `.legend-dot` | 10×10 圆点 |
| `.legend-portfolio .legend-dot` | 绿色 (`var(--positive)`) |
| `.legend-benchmark .legend-dot` | 黑色 (`var(--ink)`) |
| `.legend-benchmark-value` | 13px，黑色，加粗 |
| `.return-benchmark` | 无填充，线宽 1.8，虚线 (6 4)，opacity 0.8 |
| `.return-benchmark-positive` | 黑色 |
| `.return-benchmark-negative` | 红色 (`var(--negative)`) |

---

## 四、部署指南（Cloudflare 网页端）

### 前置条件
- Cloudflare 账号
- FRED API Key（注册地址：https://fred.stlouisfed.org/docs/api/api_key.html）

### 步骤

#### 1. 创建 KV 命名空间
- Dashboard → Workers & Pages → KV → **Create namespace**
- 名称：`SP500_KV`

#### 2. 创建 Worker
- Workers & Pages → Overview → **Create application** → **Create Worker**
- 名称：`sp500-proxy`，先 Deploy 占位
- 点 **Edit Code**，粘贴 `cloudflare/sp500-proxy/index.js` 全部内容
- **Save and Deploy**

#### 3. 绑定 KV
- Worker 详情页 → Settings → Variables → KV Namespace Bindings
- **Add binding**：
  - Variable name: `SP500_KV`
  - Namespace: 选择第 1 步创建的

#### 4. 注入 API Key
- Settings → Variables → Secrets → **Add secret**
  - Name: `FRED_API_KEY`
  - Value: `<你的 FRED API Key>`
- 再添加一个手动同步密钥：
  - Name: `SYNC_SECRET`
  - Value: `<一段足够长的随机字符串>`

#### 5. 设置 Cron
- Settings → Triggers → Cron Triggers → **Add Cron Trigger**
  - Pattern: `30 22 * * *`（每天 UTC 22:30 = 北京时间次日 06:30）

#### 6. 等待首次回填
- 首次 Cron 触发后，会自动从 FRED 拉取 1957 年至今全部 S&P 500 数据写入 KV
- 如果想立即测试，可临时改 Cron 为 `*/5 * * * *`，数据到位后改回
- 也可以部署新版 Worker 后手动触发同步：
  ```text
  https://sp500-proxy.xxx.workers.dev/admin/sync?key=<SYNC_SECRET>
  ```
  或使用请求头：
  ```text
  Authorization: Bearer <SYNC_SECRET>
  ```
- 首次回填会按 5 年一段分批请求 FRED，避免一次拉取全历史时出现 `FRED HTTP 520`。

#### 7. 更新前端
- 将 Worker 的默认域名（如 `https://sp500-proxy.xxx.workers.dev`）替换到：
- `src/app.js` 第 206 行：
  ```js
  const SP500_BENCHMARK_URL = "https://sp500-proxy.3368517784.workers.dev";
  ```

---

## 五、架构图

```
                    ┌─────────────────────┐
                    │    FRED API          │
                    │  (美联储官方 S&P 500) │
                    └────────┬────────────┘
                             │ 每天 1 次 (Cron)
                             ▼
                    ┌─────────────────────┐
       ┌────────────│  Cloudflare Worker  │◄────── Cron: 30 22 * * *
       │            │  sp500-proxy         │
       │            └────────┬────────────┘
       │                     │ 读取/写入
       │                     ▼
       │            ┌─────────────────────┐
       │            │     KV Namespace     │
       │            │     SP500_KV         │
       │            │  key: "sp500"        │
       │            │  value: {dates, closes}│
       │            └────────┬────────────┘
       │                     │
       │                     │ 读取 + 切片日期段
       │                     ▼
       │            ┌─────────────────────┐
       │            │   CDN Cache 24h     │
       │            └────────┬────────────┘
       │                     │
       │                     ▼
       │            ┌─────────────────────┐
       └───────────►│    前端 app.js      │
                    │  fetchBenchmark()   │
                    └────────┬────────────┘
                             │
                             ▼
                    ┌─────────────────────┐
                    │ buildBenchmarkRows  │
                    │  (对齐交易日, 计算   │
                    │   同期累计收益率)     │
                    └────────┬────────────┘
                             │
                             ▼
                    ┌─────────────────────┐
                    │ renderReturnCurve   │
                    │  (SVG 虚线叠加 +     │
                    │   Portfolio / S&P   │
                    │   图例对比)           │
                    └─────────────────────┘
```

---

## 六、待办事项

- [ ] 在 Cloudflare 网页端完成 Worker 部署（KV 绑定 + API Key + Cron）
- [ ] 等待首次 Cron 回填 S&P 500 历史数据
- [ ] 替换 `src/app.js` 第 206 行的 Worker URL
- [ ] 部署前端（重新 build Windows 应用或更新静态文件）
- [ ] 加载一份 IBKR 报表，确认收益率曲线出现 S&P 500 虚线叠加
