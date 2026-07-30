export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method !== 'POST') {
      return new Response('AI Chat Bot is running', { headers: { 'Content-Type': 'text/plain' } });
    }

    let update;
    try { update = await request.json(); } catch { return new Response('OK'); }


    try {
      if (update.callback_query) {
        await handleCallback(env, update.callback_query);
        return new Response('OK');
      }

      if (update.message && update.message.text) {
        const chatId = update.message.chat.id;
        const text = update.message.text;

        if (text === '/start') {
          await sendMessage(env, chatId,
            '👋 你好！我是 AI Chat 机器人\n\n' +
            '💬 直接发消息跟我对话\n' +
            '/model — 选择 AI 模型\n' +
            '/clear — 清空对话历史\n' +
            '/help — 帮助');
          return new Response('OK');
        }

        if (text === '/help') {
          const model = await getModel(env, chatId);
          await sendMessage(env, chatId,
            '🤖 AI Chat Bot\n\n' +
            '💬 直接发消息即可对话\n' +
            '/model — 选择 AI 模型\n' +
            '/clear — 清空历史\n' +
            `/current — 当前模型\n\n` +
            `当前: ${model.name}`);
          return new Response('OK');
        }

        if (text === '/current') {
          const model = await getModel(env, chatId);
          await sendMessage(env, chatId, `📌 当前模型: ${model.name}\n${model.desc}`);
          return new Response('OK');
        }

        if (text === '/clear') {
          await env.KV.delete(`session:${chatId}`);
          await sendMessage(env, chatId, '🗑 对话已清空，重新开始吧！');
          return new Response('OK');
        }

        if (text === '/model') {
          await showModelMenu(env, chatId);
          return new Response('OK');
        }

        if (text.startsWith('/')) return new Response('OK');

        const model = await getModel(env, chatId);
        const historyKey = `session:${chatId}`;
        let history = await env.KV.get(historyKey, { type: 'json' }) || [];
        history.push({ role: 'user', content: text });

        await sendChatAction(env, chatId, 'typing');

        const reply = await callNvidia(env, model.id, history);
        history.push({ role: 'assistant', content: reply });

        if (history.length > 20) history = history.slice(-20);
        await env.KV.put(historyKey, JSON.stringify(history));

        await sendMessage(env, chatId, reply);
      }
    } catch (err) {
      console.error('Error:', err);
    }

    return new Response('OK');
  }
};

// ── Models (2026-07-30 实测可用，≤8s 响应) ──────────────────────
const MODELS = [
  { id: 'meta/llama-3.1-8b-instruct',         name: 'Llama 3.1 8B',    desc: '极速响应，日常对话',         tag: 'l8' },
  { id: 'nvidia/nemotron-3-nano-30b-a3b',      name: 'Nemotron 3 Nano',  desc: 'NVIDIA 轻量版，响应极快',    tag: 'nemN' },
  { id: 'openai/gpt-oss-20b',                  name: 'GPT-OSS 20B',     desc: 'OpenAI 开源，推理快',        tag: 'gptoss' },
  { id: 'google/gemma-4-31b-it',                name: 'Gemma 4 31B',     desc: 'Google 最新开源',             tag: 'gem4' },
  { id: 'deepseek-ai/deepseek-v4-pro',         name: 'DeepSeek V4 Pro', desc: '1.6T MoE，推理最强',          tag: 'v4p' },
  { id: 'stepfun-ai/step-3.7-flash',           name: 'Step 3.7 Flash',  desc: '阶跃星辰，中文优化',          tag: 'step' },
  { id: 'nvidia/nemotron-3-super-120b-a12b',   name: 'Nemotron 3 Super', desc: 'NVIDIA 自研，1M 上下文',     tag: 'nemS' },
];

async function getModel(env, chatId) {
  const tag = await env.KV.get(`model:${chatId}`) || 'l8';
  return MODELS.find(m => m.tag === tag) || MODELS[0];
}

async function showModelMenu(env, chatId) {
  const current = await getModel(env, chatId);
  const buttons = MODELS.map(m => [{
    text: m.tag === current.tag ? `✅ ${m.name}` : m.name,
    callback_data: `model:${m.tag}`,
  }]);

  await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `🧠 选择 AI 模型\n\n当前: ${current.name}\n${current.desc}\n\n点击切换:`,
        reply_markup: { inline_keyboard: buttons },
      }),
    }
  );
}

async function handleCallback(env, callback) {
  const chatId = callback.message.chat.id;
  const data = callback.data;

  if (data.startsWith('model:')) {
    const tag = data.split(':')[1];
    const model = MODELS.find(m => m.tag === tag);
    if (!model) return;

    await env.KV.put(`model:${chatId}`, tag);

    const buttons = MODELS.map(m => [{
      text: m.tag === model.tag ? `✅ ${model.name}` : m.name,
      callback_data: `model:${m.tag}`,
    }]);

    await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: callback.message.message_id,
          text: `🧠 选择 AI 模型\n\n当前: ${model.name}\n${model.desc}\n\n点击切换:`,
          reply_markup: { inline_keyboard: buttons },
        }),
      }
    );

    await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: callback.id,
          text: `已切换到 ${model.name}`,
        }),
      }
    );
  }
}

// ── Chat ────────────────────────────────────────────────────────
async function callNvidia(env, modelId, messages) {
  const allMessages = [{ role: 'system', content: '你是一个有用的AI助手。请用中文回复。' }, ...messages];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000); // 25s 超时
    const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.NVIDIA_API_KEY}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: allMessages,
        stream: false,
        temperature: 0.7,
        max_tokens: 512,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      return `❌ 模型暂时不可用 (${res.status})\n试试 /model 换一个`;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '未收到回复';
  } catch (err) {
    if (err.name === 'AbortError') {
      return '⏱ 模型响应超时，请重试或 /model 换一个更快的模型';
    }
    return `❌ 请求失败: ${err.message}`;
  }
}

// ── Telegram helpers ─────────────────────────────────────────────
async function sendMessage(env, chatId, text) {
  const MAX = 4096;
  let remaining = text;
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, MAX);
    remaining = remaining.slice(MAX);
    await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
      }
    );
  }
}

async function sendChatAction(env, chatId, action) {
  await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/sendChatAction`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action }),
    }
  );
}
