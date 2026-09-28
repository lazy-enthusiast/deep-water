export const config = { runtime: 'edge' };

export default async function handler(req) {
  // ===== 1. 驗證 PROXY_SECRET =====
  const PROXY_SECRET = process.env.PROXY_SECRET;
  if (!PROXY_SECRET) {
    return new Response(JSON.stringify({ error: 'Server misconfigured: PROXY_SECRET missing' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  if (req.headers.get('x-proxy-secret') !== PROXY_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ===== 2. 確認 OPENROUTER_API_KEY 存在 =====
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  if (!OPENROUTER_API_KEY) {
    return new Response(JSON.stringify({ error: 'Server misconfigured: OPENROUTER_API_KEY missing' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ===== 3. CORS 預檢 =====
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': '*'
      }
    });
  }

  // ===== 4. 健康檢查 =====
  if (req.method === 'GET') {
    return new Response('OpenRouter Proxy is running!', { status: 200 });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // ===== 5. 轉發到 OpenRouter（自己注入 Authorization）=====
  try {
    const bodyText = await req.text();

    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`
      },
      body: bodyText
    });

    // 直接回傳 upstream 的 body（Edge Function 會自動串流）
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no'
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
