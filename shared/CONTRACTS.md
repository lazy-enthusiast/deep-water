# deep-water 契約文件

這份文件描述三層（前端、Worker、Proxy）之間的約定。

任何一層改動契約時，**必須同步更新這份文件**，並檢查其他層。

---

## 1. 三層職責

| 層 | 位置 | 職責 | 部署 |
|---|---|---|---|
| 前端 | `index.html` | UI、localStorage 狀態、SSE 接收 | GitHub Pages |
| Worker | `worker/src/index.js` | 驗證、摘要、記憶、模型選擇、SSE 串流 | Cloudflare Workers |
| Proxy | `proxy/api/chat.js` | 換出口 IP、持有 OpenRouter key | Vercel |

## 2. 呼叫鏈

前端 → Worker → Proxy → OpenRouter → Claude

### 2.1 前端 → Worker

- **端點**：`POST /`（Worker 根路徑）
- **Header**：`X-App-Auth: <env.NAME 的值>`
- **Body**：

```json
{
  "query": "用戶輸入",
  "historySummary": "上一輪摘要",
  "lastAiResponse": "上一輪 AI 回覆",
  "model": "auto | Haiku-4.5 | Sonnet-5",
  "action": "generateTitle（可選）",
  "attachment": { "dataUrl": "...", "mimeType": "...", "filename": "..." }
}
```

前端送到 Worker 的契約如下（含兩種 `POST`：一般對話與產生標題）。

#### URL

`https://deep-water-worker.davchan-clp.workers.dev/`

來源：`index.html` 裡的常數 `WORKER_URL`。對話與產生標題都打同一個根路徑，沒有額外 pathname。

#### HTTP method

**POST**

Worker 只接受 `POST`（`OPTIONS` 僅 CORS 預檢）。非 POST 回 405。

#### Headers

瀏覽器 `fetch` 明確設定這兩個：

| Header | 值 | 從哪來 |
|---|---|---|
| `Content-Type` | `application/json` | 前端寫死在 `fetch` 的 `headers` |
| `X-App-Auth` | 與 `NAME` 相同的字串 | 前端寫死在 `index.html` 的常數 `NAME`（不是使用者輸入、不是 localStorage、也不是環境變數） |

Worker CORS 允許的 request headers 也就是這兩個：`Content-Type`、`X-App-Auth`。

一般對話與 `generateTitle` 用同一組 headers。

#### Body JSON 欄位

前端會發出兩種 body：`JSON.stringify` 會略過值為 `undefined` 的鍵，所以沒附件時 **不會出現** `attachment`。

##### 一般對話（`_doSend`）

| 欄位 | 型別 | 可能取值 / 來源 |
|---|---|---|
| `query` | `string` | 使用者輸入。若附件是文字檔（`.txt` / `.docx` / `.xlsx`），會變成 `原文 + '\n\n【附加檔案：' + filename + '】\n' + extractedText`（擷取文字上限 40000 字，超長會加截斷標記）。圖片／PDF 時仍是純使用者文字。 |
| `historySummary` | `string` | 目前對話的 `conv.historySummary`；沒有則 `''`。之後由 Worker SSE `meta.history_summary` 寫回 localStorage。 |
| `lastAiResponse` | `string` | 送出前最後一則 `role === 'bot'` 且有 `text` 的內容；沒有則 `''`。重送時用當下傳入的 `lastAiResponse`。 |
| `model` | `string` | 該對話的 `conv.model`，對應下拉選單：`auto`、`Haiku-4.5`、`Sonnet-5`。新對話預設為選單值，沒選則 `auto`。Worker 在 `!model` 或 `model === 'auto'` 時依 complexity 分流。 |
| `attachment` | `object` 或不存在 | **僅 binary 附件**（PNG／JPEG／WEBP／PDF）才帶。文字附件已併進 `query`，不送此欄。 |

`attachment` 物件（有送時）結構：

| 子欄位 | 型別 | 可能取值 |
|---|---|---|
| `kind` | `string` | 固定 `'binary'` |
| `filename` | `string` | 使用者選的檔名 |
| `mimeType` | `string` | `file.type`，若空則依副檔名：`image/png`、`image/jpeg`、`image/webp`、`application/pdf` |
| `dataUrl` | `string` | `FileReader.readAsDataURL` 的 data URL（含 `data:...;base64,...`）。前端檔案上限 15MB；Worker 另檢查 `dataUrl.length > 22MB` 則 413 |

Worker 另外會從 body 解出 `action`，一般對話 **不帶** 這個欄位。

##### 產生標題（`fetchAutoTitle`，第一則訊息且有完整回覆後）

| 欄位 | 型別 | 可能取值 / 來源 |
|---|---|---|
| `action` | `string` | 固定 `'generateTitle'`。Worker 看到這個就走標題路徑，不跑摘要／SSE。 |
| `query` | `string` | 該則使用者原始提問（不含文字附件拼接）。必填，否則 Worker 400。 |
| `lastAiResponse` | `string` | 當輪 AI 完整回覆文字。 |

這條請求 **不帶** `historySummary`、`model`、`attachment`。

### 2.2 Worker → Proxy

Worker 打 proxy 一律是 **POST**，走同一個 URL、同一組 headers；差別只在 body（三種 OpenRouter `chat/completions` payload）。Proxy 把 body **原樣轉發**到 `https://openrouter.ai/api/v1/chat/completions`，自己另外注入 `Authorization`。

#### URL

`env.PROXY_URL`，沒設時 fallback：

`https://openrouter-proxy-eight-umber.vercel.app/api/chat`

對應 Vercel 的 `proxy/api/chat.js`。

#### HTTP method

**POST**

同步用 `callOpenRouterSync`（預設 timeout 55 秒），串流用 `callOpenRouterStream`（無 timeout）。兩邊 URL、headers 相同。

#### Headers

由 `buildProxyHeaders(env)` 組出來：

| Header | 值 | 從哪來 |
|---|---|---|
| `Content-Type` | `application/json` | Worker 寫死 |
| `X-Proxy-Secret` | Cloudflare Worker 的 `env.PROXY_SECRET` | **只有這個 env 有值時才帶** |

Worker **不帶** OpenRouter key。Proxy 用 `req.headers.get('x-proxy-secret')` 對 `process.env.PROXY_SECRET` 比對（HTTP header 名稱不分大小寫），不符回 401。

#### Body

JSON，本質是 OpenRouter Chat Completions 請求。串流路徑會在原 body 上多加 `stream: true`。

##### 產生標題（`action === 'generateTitle'`，同步）

| 欄位 | 型別 | 取值 |
|---|---|---|
| `model` | `string` | 固定 `meta-llama/llama-3.1-8b-instruct` |
| `temperature` | `number` | `0.3` |
| `max_tokens` | `number` | `50` |
| `messages` | `array` | 兩則：system（標題生成器指示）+ user（`用戶提問：${query}\nAI回答：${lastAiResponse.slice(0, 300)}`） |
| `stream` | — | **不帶**（同步 `r.json()`） |

##### 摘要 + 複雜度（每輪對話，同步，與 Mem0 平行）

| 欄位 | 型別 | 取值 |
|---|---|---|
| `model` | `string` | 固定 `deepseek/deepseek-v4-flash` |
| `temperature` | `number` | `0.1` |
| `top_p` | `number` | `0.6` |
| `response_format` | `object` | `{ type: 'json_object' }` |
| `messages` | `array` | system = `SUMMARIZER_SYSTEM`；user = 既有背景 / 上一輪回覆 / 本次發言（有 binary 附件時加一句「附加了檔案…」註記，**不含** dataUrl） |
| `stream` | — | **不帶** |

##### 正式回答（串流）

Worker 先組 `answerBody`，再 `callOpenRouterStream` → 變成 `{ ...answerBody, stream: true }`。

| 欄位 | 型別 | 取值 |
|---|---|---|
| `model` | `string` | `anthropic/claude-haiku-4.5` 或 `anthropic/claude-sonnet-5`（來自 `MODEL_CONFIG`） |
| `max_tokens` | `number` | `8201` |
| `temperature` | `number` 或不存在 | 只有 Haiku 帶 `0.3`；Sonnet **不帶** 這個欄位 |
| `messages` | `array` | 見下 |
| `plugins` | `array` 或不存在 | 僅 PDF：`[{ id: 'file-parser', pdf: { engine: 'native' } }]` |
| `stream` | `boolean` | 固定 `true`（函式裡加上去的） |

`messages` 固定兩則：

1. **system**：`content` 是陣列
   - 第一塊：`SHARED_CORE_SYSTEM`，且 `cache_control: { type: 'ephemeral' }`
   - 第二塊：`dynamicContextText`（長期記憶 + 新摘要 + 上一輪回覆）
2. **user**：
   - 無 binary 附件：`content` 是字串 `query`
   - 有 PDF：`[{ type: 'text', text: query }, { type: 'file', file: { filename, file_data: dataUrl } }]`
   - 有 PNG/JPEG/WEBP：`[{ type: 'text', text: query }, { type: 'image_url', image_url: { url: dataUrl } }]`

不支援的 mime 時 `buildAttachmentBlock` 回 `null`，user content 就只剩字串 `query`。

### 2.3 Proxy → OpenRouter

Proxy 驗證過 `X-Proxy-Secret` 之後，把 Worker 送來的 body **一字不改**轉去 OpenRouter。自己只負責加上 API key。

#### URL

`https://openrouter.ai/api/v1/chat/completions`

寫死在 `proxy/api/chat.js`，沒有環境變數覆寫。

#### HTTP method

**POST**

#### Headers

Proxy 打 OpenRouter **只帶這兩個**（Worker 的 `X-Proxy-Secret` **不會**轉發）：

| Header | 值 | 從哪來 |
|---|---|---|
| `Content-Type` | `application/json` | Proxy 寫死 |
| `Authorization` | `Bearer ${OPENROUTER_API_KEY}` | Vercel `process.env.OPENROUTER_API_KEY`（全系統唯一下游持有這個 key 的地方） |

沒有 `HTTP-Referer`、`X-Title` 或其他 OpenRouter 選用 header。

#### Body

`const bodyText = await req.text()`，再當 `fetch` 的 `body` 送出。

**不** `JSON.parse`、**不增刪欄位。** Worker 三種 payload 原樣過去：

1. 標題：Llama 3.1，無 `stream`
2. 摘要：DeepSeek + `response_format: json_object`，無 `stream`
3. 正式回答：Claude + `stream: true`（可能含 `plugins`、圖片／PDF content）

回應用 `new Response(upstream.body, …)` 直接串流；`Content-Type` 用 upstream 的（沒有則 fallback `text/event-stream`）。

## 3. SSE 回應

Worker 回前端的串流契約如下。這只發生在**一般對話**；`generateTitle` 是普通 JSON `{ title }`，不是 SSE。

### 回應 headers

| Header | 值 |
|---|---|
| `Content-Type` | `text/event-stream; charset=utf-8` |
| `Cache-Control` | `no-cache` |
| `Connection` | `keep-alive` |
| `X-Used-Model` | 實際模型鍵：`Haiku-4.5` 或 `Sonnet-5` |
| CORS | `Access-Control-Allow-Origin` 等；expose：`X-Used-Model`、`X-Complexity`、`X-Task-Tag`（後兩個 **沒** 寫進 response header，只在第一個 SSE event 裡） |

### 線上格式

每則 event 都是 SSE 慣例：

```
data: <JSON 或 [DONE]>\n\n
```

前端只處理 `data: ` 開頭的行；`data: [DONE]` 直接跳過。

#### 第一個 event：Worker 自己寫的 `meta`

Worker 在轉發 OpenRouter 串流**之前**先 enqueue 這一包：

```json
{
  "type": "meta",
  "history_summary": "<字串，新摘要>",
  "complexity": 1,
  "task_tag": "<字串，可為空>",
  "raw_summary": "<摘要模型原始輸出字串>",
  "used_model": "Haiku-4.5"
}
```

| 欄位 | 型別 | 意義 |
|---|---|---|
| `type` | `string` | 固定 `"meta"`，前端靠這個辨識 |
| `history_summary` | `string` | 解析後的新摘要；前端寫進 `conv.historySummary` |
| `complexity` | `number` | 1–10 整數；解析失敗則 `5` |
| `task_tag` | `string` | 任務標籤；沒有則 `''` |
| `raw_summary` | `string` | DeepSeek 原始 content（debug「查看摘要／評分過程」） |
| `used_model` | `string` | `Haiku-4.5` 或 `Sonnet-5`（auto 分流或手動指定後的結果） |

前端收到後更新摘要／評分／debug，**不當成 token 顯示**。

#### 後續 event：OpenRouter 原樣轉發

Worker **不改** chunk 內容，proxy 也不改，所以之後是 OpenRouter Chat Completions stream：

```
data: {"id":"...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"某段文字"},"finish_reason":null}],...}

data: [DONE]
```

前端取 token 的順序：

1. `json.choices[0].delta.content`（OpenRouter 標準）
2. 否則 `json.delta.text`（備援）
3. 沒有就當空字串、不渲染

結束標記是 `data: [DONE]`，前端忽略。讀完 `ReadableStream` 後再做最後一次 markdown 渲染。

對照：第一個 event 一定有 `"type":"meta"`；後面的 chunk **沒有** `type: meta`，而是帶 `choices[].delta.content`。

## 4. 模型清單

Worker 裡實際出現的模型就這四個：兩個給正式回答（有內部鍵），兩個寫死給輔助任務。

### 正式回答（`MODEL_CONFIG`）

| 內部鍵（前端 `model` / SSE `used_model`） | OpenRouter `model` | 用途 | 何時選到 | 參數 |
|---|---|---|---|---|
| `Haiku-4.5` | `anthropic/claude-haiku-4.5` | 輕量幕僚回答 | 使用者選 Haiku；或 `auto`／沒指定且 **complexity ≤ 4** | `max_tokens: 8201`，`temperature: 0.3` |
| `Sonnet-5` | `anthropic/claude-sonnet-5` | 複雜幕僚回答 | 使用者選 Sonnet；或 `auto`／沒指定且 **complexity > 4**；內部鍵不在 pool 裡時也 fallback 這裡 | `max_tokens: 8201`，**不設** temperature |

`pickModelKey`：complexity 非數字時當 **5** → 走 Sonnet。`auto` 和空值才走這套分流。

### 輔助任務（不進模型池、不回給前端當 `used_model`）

| OpenRouter `model` | 用途 | 何時打 | 參數 |
|---|---|---|---|
| `deepseek/deepseek-v4-flash` | 對話摘要 + complexity（1–10）+ `task_tag` | 每輪一般對話，與 Mem0 平行、**同步** | `temperature: 0.1`，`top_p: 0.6`，`response_format: json_object` |
| `meta-llama/llama-3.1-8b-instruct` | 產生 3–5 字繁中標題 | 前端 `action: 'generateTitle'`，**同步** | `temperature: 0.3`，`max_tokens: 50` |

### 對前端的對應

前端下拉只有 `auto` / `Haiku-4.5` / `Sonnet-5`。Worker 回 SSE meta 的 `used_model` 永遠是後兩個內部鍵之一，不會是 DeepSeek 或 Llama 的 OpenRouter id。

## 5. localStorage

`index.html` 只用兩個 key：`conversations` 和 `theme`。目前對話 id（`activeId`）只存在記憶體，重新整理後會選陣列第一筆。

### `theme`

| | |
|---|---|
| 型別 | `string` |
| 取值 | `'dark'` 或 `'light'` |
| 讀 | 載入時若 `=== 'dark'` 就加 `body.dark` |
| 寫 | 按主題鈕時依現在 class 寫入 |

沒設過這個 key 時維持亮色（DOM 預設沒有 `dark`）。

### `conversations`

JSON 陣列。載入用 `JSON.parse(... || '[]')`，再過濾掉不是物件、沒有 `id`、或 `messages` 不是陣列的項目。

寫入時會去掉 `lastAttachment`、`lastAiResponse`（這兩個只活在記憶體）。載入後也會再清一次：`lastAttachment = undefined`、`lastAiResponse = ''`。

#### 每個對話物件

| 欄位 | 型別 | 會進 localStorage？ | 說明 |
|---|---|---|---|
| `id` | `string` | 是 | `Date.now().toString()` |
| `title` | `string` | 是 | 新對話 `'新對話'`；第一則訊息先改成前 15 字 + `...`；之後可能被 `generateTitle` 覆寫 |
| `model` | `string` | 是 | `'auto'` / `'Haiku-4.5'` / `'Sonnet-5'` |
| `historySummary` | `string` | 是 | 初始 `''`；SSE `meta.history_summary` 寫回 |
| `messages` | `array` | 是 | 見下表 |
| `lastQuery` | `string` | **會**（沒被 strip） | 最後一次送出的使用者文字；給錯誤重送用 |
| `lastAttachment` | `object` / `undefined` | **否** | binary 或 text 附件；存檔時拿掉，重整後無法帶附件重送 |
| `lastAiResponse` | `string` | **否** | 送出前最後一則 bot 文字；存檔拿掉，載入設 `''` |

#### `messages[]` 每則

| 欄位 | 型別 | 出現在 | 說明 |
|---|---|---|---|
| `role` | `string` | 全部 | `'user'` / `'bot'` / `'error'` |
| `text` | `string` | 全部 | 使用者原文、串流累積、或 `'連線失敗：' + err.message` |
| `time` | `number` | 全部 | `Date.now()` |
| `attachmentName` | `string` | 僅 user，有附件時 | 檔名；沒附件則 `undefined`，`JSON.stringify` 會略過 |
| `usedModel` | `string` | 僅 bot | SSE `used_model`（`Haiku-4.5` / `Sonnet-5`） |
| `complexity` | `number` | 僅 bot | SSE `complexity` |
| `taskTag` | `string` | 僅 bot | SSE `task_tag`，可為 `''` |
| `summarizerRaw` | `string` | 僅 bot | SSE `raw_summary`，debug 用 |

#### 範例

```json
[
  {
    "id": "1730000000000",
    "title": "某標題",
    "model": "auto",
    "historySummary": "……",
    "lastQuery": "上一則使用者問題",
    "messages": [
      {
        "role": "user",
        "text": "請幫我寫簽呈",
        "time": 1730000001000,
        "attachmentName": "draft.pdf"
      },
      {
        "role": "bot",
        "text": "主旨：……",
        "time": 1730000002000,
        "usedModel": "Sonnet-5",
        "complexity": 7,
        "taskTag": "公文簽呈",
        "summarizerRaw": "{...}"
      }
    ]
  }
]
```

存檔失敗只 `console.error`，不會另開 key。
