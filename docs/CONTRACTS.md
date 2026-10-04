# deep-water 系統架構

個人用 AI 幕僚 Chatbot：政策分析、公文產製、決策支援。前端是靜態 HTML（GitHub Pages），邏輯在 Cloudflare Worker。辦公室網路無法直連 Claude，因此經 Vercel Proxy 換出口 IP 再打 OpenRouter。

三層各有存在理由，不要合併。改請求／回應 shape 時，同步檢查 `index.html`、Worker、Proxy。所有金鑰走環境變數，不要硬編碼進 Worker 或 Proxy。

更細的前後端欄位契約見 `shared/CONTRACTS.md`。

---

## 系統架構總覽

資料流：

```
瀏覽器 (GitHub Pages)
  index.html
        |  X-App-Auth
        v
Cloudflare Worker
  worker/src/index.js  ←  import  worker/src/brain.js
        |  X-Proxy-Secret
        v
Vercel Proxy
  proxy/api/chat.js
        |  Authorization: Bearer <OPENROUTER_API_KEY>
        v
OpenRouter  →  Claude / 其他模型
```

一輪對話大致是：

1. 前端 `loadModels()` 打 `GET /api/models`（不帶暗號），填下拉選單。
2. 送出時 `POST /`，帶 `X-App-Auth`、JSON（query、historySummary、lastAiResponse、model、可選 attachment）。
3. Worker 驗證暗號後，平行跑摘要（deepseek-v4-flash）與 Mem0 檢索。
4. 依 `complexity` 或使用者指定的 key 選正式回答模型，組 system（幕僚 prompt + 動態脈絡），經 Proxy 向 OpenRouter 串流。
5. SSE 第一個 event 是 `type: "meta"`（含新摘要、複雜度、實際模型）；其後是 OpenRouter token。前端把 `history_summary` 寫回 localStorage。

```
前端 ──GET /api/models──► Worker（公開，從 MODEL_CONFIG 產出清單）
前端 ──POST /──────────► Worker ──► Proxy ──► OpenRouter
                         │            ▲
                         ├─ 摘要 / 標題（同步）
                         ├─ 正式回答（SSE）
                         └─ Mem0 search / add
```

---

## 目錄結構

| 路徑 | 用途 |
|---|---|
| `index.html` | 前端全部 UI 與客戶端邏輯；部署於 GitHub Pages |
| `worker/` | Cloudflare Worker |
| `worker/src/index.js` | 路由、驗證、Mem0、SSE、組請求 |
| `worker/src/brain.js` | 幕僚 prompt、摘要 prompt、模型清單、`pickModelKey` |
| `worker/wrangler.toml` | Worker 名稱、`main`、公開 vars（不含 secret） |
| `proxy/` | Vercel Edge Function |
| `proxy/api/chat.js` | 驗證後把 body 原樣轉發 OpenRouter |
| `docs/CONTRACTS.md` | 本檔：架構與層間約定 |
| `shared/CONTRACTS.md` | 更細的 HTTP／SSE 欄位契約 |
| `.cursorrules` | 給 AI 助手的專案約束 |

---

## 各層職責

### `index.html`（前端容器）

- 持有 UI 狀態與 localStorage（對話列表、`historySummary`、主題）。
- 常數 `WORKER_URL` 指向 Worker；`NAME` 作為 `X-App-Auth` 暗號（與 Worker `env.NAME` 對齊）。不要把 OpenRouter key 放這裡。
- 啟動時 `loadModels()`：`GET ${WORKER_URL}api/models`，動態生成 `#modelSelect` 的 `<option>`（`value` = `key`，顯示 `label（description）`），`default` 設為 selected，並把 `key → label` 存進 `MODEL_NAMES`。清單載入完才初始化對話。
- 對話：`POST` Worker 根路徑，收 SSE；第一個 `meta` 更新摘要與訊息上的模型／複雜度標籤。
- `action: "generateTitle"` 另一次 `POST`，產生側欄標題。
- 附件：文字檔併進 `query`；圖片／PDF 以 `attachment`（dataUrl）送出。

### `worker/src/index.js`（路由、驗證、串流、記憶）

- CORS：`ALLOWED_ORIGIN`；預檢 `OPTIONS`。
- `GET /api/models`：不驗證暗號，從 `MODEL_CONFIG` 產出 `{ models, default }`。
- `POST /upload`、`POST /`：timing-safe 比對 `X-App-Auth` 與 `env.NAME`。
- `POST /`：`generateTitle` 用 Llama 3.1 8B 同步回 JSON；一般對話先摘要 + Mem0，再選模型、組 system、經 Proxy SSE。
- System 兩塊：`SHARED_CORE_SYSTEM`（`cache_control: ephemeral`）+ 動態脈絡（長期記憶、摘要、上一輪回覆）。
- SSE 開頭插入 `meta`；串流結束後 `waitUntil(mem0Add)`。
- 不持有 `OPENROUTER_API_KEY`；打 Proxy 時帶 `X-Proxy-Secret`。

### `worker/src/brain.js`（prompt、模型清單、選模型邏輯）

- `SHARED_CORE_SYSTEM`：幕僚角色與公文規範。很長，改動會影響 prompt caching 成本。
- `SUMMARIZER_SYSTEM`：只輸出 `{ history_summary, complexity, task_tag }`。
- `DEFAULT_MODEL_KEY`：目前 `'auto'`。
- `MODEL_CONFIG`：前端可見的模型池。`auto` 只有 `label`、`description`；實際模型另有 `model`、`max_tokens`、可選 `temperature`。
- `pickModelKey(complexity)`：分數無效當 5；`<= 4` → `Haiku-4.5`，否則 `Sonnet-5`。
- 摘要／標題用的模型 ID 寫在 `index.js`，不在 `MODEL_CONFIG`。

動 token 預算、摘要觸發、模型選擇前先問專案負責人。

### `proxy/api/chat.js`（OpenRouter 轉發）

- Vercel Edge。驗證 `x-proxy-secret` === `PROXY_SECRET`。
- 注入 `Authorization: Bearer OPENROUTER_API_KEY`，把 POST body 原樣轉到 `https://openrouter.ai/api/v1/chat/completions`。
- 回傳 upstream status／body（含 SSE）。`GET` 為健康檢查字串。不解析、不改 model。

---

## 環境變數與 Secret

**不要把實際值寫進 repo 或本文件。** `wrangler.toml` `[vars]` 只放非機密公開值。

### Cloudflare Worker

| 變數 | 用途 |
|---|---|
| `NAME` | 前端 `X-App-Auth` 暗號（名稱易誤導，它是密鑰） |
| `PROXY_URL` | Vercel Proxy URL（應含 `/api/chat`） |
| `PROXY_SECRET` | 打 Proxy 的 `X-Proxy-Secret` |
| `MEM0_API_KEY` | Mem0 API |
| `MEM0_USER_ID` | Mem0 使用者 ID（單人使用） |
| `ALLOWED_ORIGIN` | CORS 允許來源 |
| `MY_BUCKET` | R2 binding（`POST /upload`；未綁定則上傳不寫物件） |

### Vercel Proxy

| 變數 | 用途 |
|---|---|
| `PROXY_SECRET` | 必須與 Worker 的 `PROXY_SECRET` 相同 |
| `OPENROUTER_API_KEY` | 全系統唯一持有 OpenRouter key 的地方 |

前端 `WORKER_URL`、`NAME` 目前寫在 `index.html`。改暗號時 Worker `NAME` 與前端必須一起改。

---

## API 端點（Worker）

CORS 皆套用。Proxy 本身不是給瀏覽器打的。

### `GET /api/models`

不驗證暗號。

```json
{
  "models": [{ "key": "auto", "label": "自動", "description": "依複雜度智能分流" }],
  "default": "auto"
}
```

`models` 由 `Object.entries(MODEL_CONFIG)` 生成，只暴露 `key`、`label`、`description`。`default` = `DEFAULT_MODEL_KEY`。

### `POST /upload`

需 `X-App-Auth`。`multipart/form-data`，欄位 `file`。有 `MY_BUCKET` 則寫入 R2。成功 JSON：`success`、`filename`、`message`。

### `POST /`（根路徑）

需 `X-App-Auth`、`Content-Type: application/json`。

**一般對話** body：`query`、`historySummary`、`lastAiResponse`、`model`、可選 `attachment`。回應 `text/event-stream`：

1. `data: {"type":"meta","history_summary","complexity","task_tag","raw_summary","used_model"}`
2. 其後 OpenRouter SSE（`choices[0].delta.content`）
3. Header `X-Used-Model` 為實際 key（`auto` 會被解析成 Haiku 或 Sonnet）

`model` 為空或 `'auto'` 時呼叫 `pickModelKey`；否則用該 key 查 `MODEL_CONFIG`，找不到則 fallback `Sonnet-5`。

**產生標題** 同一路徑，body 加 `"action": "generateTitle"`，另需 `query`、`lastAiResponse`。回應 JSON `{ "title": "..." }`，非 SSE。

---

## 如何新增模型

只改 `worker/src/brain.js` 的 `MODEL_CONFIG`（必要時一併改 `DEFAULT_MODEL_KEY`、`pickModelKey`）。部署 Worker 後，前端下次載入會打 `GET /api/models`，下拉選單自動同步，不必改 `index.html` 的 option。

新增可被使用者選中、可實際呼叫的模型：

```js
'新Key': {
  label: '顯示名稱',
  description: '簡短說明',
  model: 'openrouter/model-id',
  max_tokens: 8201,
  temperature: 0.3   // 可省略
}
```

- `key` 是前端 `option.value` 與對話 `conv.model`。
- `auto` 不要加 `model`／`max_tokens`／`temperature`；它不是 OpenRouter 模型。
- 若希望 `auto` 會選到新模型，改 `pickModelKey`。否則使用者只能手動選。
- `index.js` 的 fallback 仍是 `MODEL_CONFIG['Sonnet-5']`；刪掉 Sonnet 時要改這行。
- 摘要（deepseek-v4-flash）與標題（llama-3.1-8b-instruct）不走 `MODEL_CONFIG`。
- `SHARED_CORE_SYSTEM`、`SUMMARIZER_SYSTEM` 與加模型無關，不要順便改。
