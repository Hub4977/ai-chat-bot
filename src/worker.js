export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── Web 页面 ──
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await env.KV.get('web:html');
      return new Response(html || 'Web page not found', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // ── Web API ──
    if (url.pathname.startsWith('/api/')) {
      return handleWebAPI(url.pathname, request, env);
    }

    // ── Telegram Webhook（POST）──
    if (request.method === 'POST') {
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
          await env.KV.put(`sub:${chatId}`, '1'); // 自动订阅新闻
          await sendMessage(env, chatId,
            '👋 你好！我是智能体科技\n\n' +
            '💬 直接发消息跟我对话\n' +
            '/model — 选择 AI 模型\n' +
            '/fast — 自动测速选最快模型\n' +
            '/news — 获取今日新闻\n' +
            '/key — 更新 AI 密钥\n' +
            '/clear — 清空对话历史\n' +
            '/help — 帮助\n\n' +
            '📰 每天 6:00 自动推送新闻\n' +
            '🔄 API失效自动切换备用AI');
          return new Response('OK');
        }

        if (text === '/help') {
          const model = await getModel(env, chatId);
          await sendMessage(env, chatId,
            '🤖 AI Chat Bot\n\n' +
            '💬 直接发消息即可对话\n' +
            '/model — 选择 AI 模型\n' +
            '/fast — 自动测速选最快\n' +
            '/news — 获取今日新闻\n' +
            '/key nvapi-xxx — 更新密钥\n' +
            '/clear — 清空历史\n' +
            '/current — 当前模型\n\n' +
            '当前: ' + model.name);
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

        if (text === '/news') {
          await sendChatAction(env, chatId, 'typing');
          const news = await fetchNews(env);
          await sendMessage(env, chatId, news);
          return new Response('OK');
        }

        if (text === '/fast') {
          await sendChatAction(env, chatId, 'typing');
          const result = await autoSelectFastest(env, chatId);
          await sendMessage(env, chatId, result);
          return new Response('OK');
        }

        if (text.startsWith('/key ')) {
          const newKey = text.substring(5).trim();
          if (newKey.startsWith('nvapi-')) {
            await env.KV.put('nvidia_key', newKey);
            await env.KV.delete('nvidia_fail');
            await sendMessage(env, chatId, '✅ NVIDIA API Key 已更新，已恢复正常通道');
          } else {
            await sendMessage(env, chatId, '❌ 无效的 Key 格式，应以 nvapi- 开头');
          }
          return new Response('OK');
        }

        if (text.startsWith('/')) return new Response('OK');

        const model = await getModel(env, chatId);
        const historyKey = `session:${chatId}`;
        let history = await env.KV.get(historyKey, { type: 'json' }) || [];
        history.push({ role: 'user', content: text });

        await sendChatAction(env, chatId, 'typing');

        const reply = await callAI(env, model.id, history);
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

    // 其他请求返回首页
    const fallbackHtml = await env.KV.get('web:html');
    return new Response(fallbackHtml || 'Not found', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  },

  // ── Cron Trigger: 每天北京时间 6:00 (UTC 22:00) ─────────────────
  async scheduled(event, env) {
    const news = await fetchNews(env);
    // 推送给所有订阅用户
    const subs = await env.KV.list({ prefix: 'sub:' });
    for (const sub of subs.keys) {
      const chatId = sub.name.replace('sub:', '');
      await sendMessage(env, chatId, news);
    }
  },
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

// 自动测速选最快模型
async function autoSelectFastest(env, chatId) {
  // 检查缓存（1小时内有效）
  const cached = await env.KV.get('speed:fastest', { type: 'json' });
  if (cached && cached.tag && (Date.now() - cached.ts < 3600000)) {
    await env.KV.put(`model:${chatId}`, cached.tag);
    return '🚀 已自动切换到最快模型: ' + cached.name + '\n响应: ' + cached.ms + 'ms\n\n缓存有效中（1小时内不重测），下次 /fast 可重新测速';
  }

  // 并行测速所有模型
  var results = [];
  var tests = MODELS.map(function(m) {
    return (async function() {
      var start = Date.now();
      try {
        var controller = new AbortController();
        var timeout = setTimeout(function() { controller.abort(); }, 8000);
        var res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + (await getNvidiaKey(env)),
          },
          body: JSON.stringify({
            model: m.id,
            messages: [{ role: 'user', content: 'Hi' }],
            stream: false,
            temperature: 0,
            max_tokens: 5,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        var ms = Date.now() - start;
        if (res.ok) {
          results.push({ tag: m.tag, name: m.name, ms: ms, ok: true });
        } else {
          results.push({ tag: m.tag, name: m.name, ms: ms, ok: false });
        }
      } catch (e) {
        results.push({ tag: m.tag, name: m.name, ms: 9999, ok: false });
      }
    })();
  });
  await Promise.all(tests);

  // 按响应时间排序
  results.sort(function(a, b) { return a.ms - b.ms; });

  // 选出最快的可用模型
  var fastest = results.find(function(r) { return r.ok; });
  if (!fastest) return '❌ 所有模型当前不可用，请稍后再试';

  // 缓存并设置
  await env.KV.put('speed:fastest', JSON.stringify({ tag: fastest.tag, name: fastest.name, ms: fastest.ms, ts: Date.now() }));
  await env.KV.put(`model:${chatId}`, fastest.tag);

  // 生成报告
  var report = '🚀 模型测速完成，已切换到最快: ' + fastest.name + ' (' + fastest.ms + 'ms)\n\n';
  report += '📊 测速排名:\n';
  results.forEach(function(r, i) {
    var icon = r.ok ? (r.tag === fastest.tag ? '🥇' : '  ') : '❌';
    report += icon + ' ' + r.name + ': ' + (r.ok ? r.ms + 'ms' : '失败') + '\n';
  });
  return report;
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

// ── News ─────────────────────────────────────────────────────────
const QUOTES = [
  '不积跬步，无以至千里；不积小流，无以成江海。',
  '世界上最快乐的事，莫过于为理想而奋斗。',
  '每一个不曾起舞的日子，都是对生命的辜负。',
  '星光不问赶路人，时光不负有心人。',
  '你若盛开，清风自来。',
  '把每一个黎明看作生命的开始，把每一个黄昏看作生命的小结。',
  '成功不是终点，失败也不是终结，唯有继续前进的勇气才最重要。',
  '所有的努力，不是为了让别人觉得你了不起，而是为了让自己打心里看得起自己。',
  '生活不可能像你想象的那么好，但也不会像你想象的那么糟。',
  '越是优秀的人越努力，越是富有的人越勤奋，越是智慧的人越谦卑。',
  '当你觉得坚持不下去的时候，恰恰是你需要再坚持一下的时候。',
  '没有伞的孩子必须努力奔跑。',
  '你所浪费的今天，是昨天殒命之人所奢望的明天。',
  '不要因为走得太远，而忘记为什么出发。',
  '人生没有白走的路，每一步都算数。',
  '你现在的努力，是为了将来有更多选择的权利。',
  '所谓万丈深渊，下去也是前程万里。',
  '种一棵树最好的时间是十年前，其次是现在。',
  '山高路远，看世界，也找自己。',
  '如果结果不如你所愿，那说明还未到最后。',
  '愿你所有的努力都不会白费，愿所有的美好都如期而至。',
  '最暗的夜，才能看见最美的星光。',
  '凡是过往，皆为序章。',
  '你只管努力，剩下的交给时间。',
  '有志者事竟成，破釜沉舟，百二秦关终属楚。',
];

async function fetchNews(env) {
  const now = new Date();
  const dateStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}-${String(now.getUTCDate()).padStart(2,'0')}`;

  // 并行抓取国际新闻（多源）+ 国内新闻
  const [intlTitles, cnTitles] = await Promise.all([
    fetchIntlNews(),
    fetchChineseNews(),
  ]);

  // AI 批量翻译国际新闻为中文（10条一起，约1.5秒）
  var intlCn = await aiTranslate(env, intlTitles.slice(0, 10));
  // 国内新闻也用 AI 精炼一下标题
  var cnCn = await aiTranslate(env, cnTitles.slice(0, 10));

  // 随机选金句
  const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];

  var text = '📰 每日新闻简报 | ' + dateStr + '\n━━━━━━━━━━━━━━━\n\n';
  text += '🌍 国际要闻\n';
  intlCn.forEach(function(t, i) { text += (i+1) + '. ' + t + '\n'; });
  text += '\n🇨🇳 国内要闻\n';
  cnCn.forEach(function(t, i) { text += (i+1) + '. ' + t + '\n'; });
  text += '\n✨ 每日金句\n「' + quote + '」\n';
  return text;
}

// AI 批量翻译：NVIDIA → Workers AI → MyMemory 三级降级
async function aiTranslate(env, titles) {
  if (!titles || titles.length === 0) return ['暂无数据'];
  var numbered = '';
  for (var i = 0; i < titles.length; i++) {
    numbered += (i+1) + '. ' + titles[i] + '\n';
  }
  var prompt = '将以下新闻标题翻译为简体中文，只输出翻译结果，每行一条，保留编号前缀，不要加任何其他内容：\n\n' + numbered;
  var sysMsg = '你是一个翻译器。只输出简体中文翻译结果，不加任何解释。';

  // 第1级：NVIDIA API（如果没失效）
  if (!(await isNvidiaDown(env))) {
    try {
      var controller = new AbortController();
      var timeout = setTimeout(function() { controller.abort(); }, 15000);
      var key = await getNvidiaKey(env);
      var res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + key,
        },
        body: JSON.stringify({
          model: 'meta/llama-3.1-8b-instruct',
          messages: [
            { role: 'system', content: sysMsg },
            { role: 'user', content: prompt }
          ],
          stream: false,
          temperature: 0.0,
          max_tokens: 600,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        var data = await res.json();
        var content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
        var lines = content.split('\n').map(function(l) {
          return l.replace(/^\d+[\.\s]+/, '').trim();
        }).filter(function(l) { return l.length > 2; });
        if (lines.length >= 5) {
          await markNvidiaUp(env);
          return lines;
        }
      }
      // 401/403/429 记录失败（保守：只记录不立即降级）
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        await recordNvidiaFail(env);
      }
    } catch (e) {
      console.error('NVIDIA translate error:', e);
    }
  }

  // 第2级：Cloudflare Workers AI 兜底
  try {
    if (env.AI) {
      var aiInput = {
        messages: [
          { role: 'system', content: sysMsg },
          { role: 'user', content: prompt }
        ]
      };
      var aiRes = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', aiInput);
      if (aiRes && aiRes.response) {
        var lines = aiRes.response.split('\n').map(function(l) {
          return l.replace(/^\d+[\.\s]+/, '').trim();
        }).filter(function(l) { return l.length > 2; });
        if (lines.length >= 5) return lines;
      }
    }
  } catch (e) {
    console.error('Workers AI translate error:', e);
  }

  // 第3级：MyMemory 逐条翻译兜底
  var fallback = [];
  for (var i = 0; i < titles.length && fallback.length < 10; i++) {
    var t = await mymemoryTranslate(titles[i]);
    fallback.push(t);
  }
  return fallback.length > 0 ? fallback : titles;
}

// ── MyMemory 免费翻译 API（兜底）────────────────────────────
async function mymemoryTranslate(text) {
  try {
    var url = 'https://api.mymemory.translated.net/get?q=' +
      encodeURIComponent(text) + '&langpair=en|zh-CN';
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 8000);
    var res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      var data = await res.json();
      var translated = data && data.responseData && data.responseData.translatedText;
      if (translated && translated !== text) {
        return translated;
      }
    }
  } catch (e) {
    console.error('MyMemory error:', e);
  }
  return text;
}

// ── 国际新闻：多源抓取 ──────────────────────────────────────
async function fetchIntlNews() {
  var titles = [];

  // BBC News
  try {
    var res = await fetch('https://feeds.bbci.co.uk/news/rss.xml');
    var xml = await res.text();
    var matches = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.+?)(?:\]\]>)?<\/title>/g)];
    for (var i = 1; i < matches.length && titles.length < 15; i++) {
      var t = matches[i][1].trim();
      if (t.length > 10) titles.push(t);
    }
  } catch {}

  // NYTimes
  if (titles.length < 15) {
    try {
      var res = await fetch('https://rss.nytimes.com/services/xml/rss/nyt/World.xml');
      var xml = await res.text();
      var matches = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.+?)(?:\]\]>)?<\/title>/g)];
      for (var i = 1; i < matches.length && titles.length < 15; i++) {
        var t = matches[i][1].trim();
        if (t.length > 10 && titles.indexOf(t) === -1) titles.push(t);
      }
    } catch {}
  }

  // Al Jazeera
  if (titles.length < 15) {
    try {
      var res = await fetch('https://www.aljazeera.com/xml/rss/all.xml');
      var xml = await res.text();
      var matches = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.+?)(?:\]\]>)?<\/title>/g)];
      for (var i = 1; i < matches.length && titles.length < 15; i++) {
        var t = matches[i][1].trim();
        if (t.length > 10 && titles.indexOf(t) === -1) titles.push(t);
      }
    } catch {}
  }

  // The Verge / TechCrunch / Ars Technica（科技补充）
  if (titles.length < 15) {
    try {
      var res = await fetch('https://www.theverge.com/rss/index.xml');
      var xml = await res.text();
      var matches = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.+?)(?:\]\]>)?<\/title>/g)];
      for (var i = 1; i < matches.length && titles.length < 15; i++) {
        var t = matches[i][1].trim();
        if (t.length > 10 && titles.indexOf(t) === -1) titles.push(t);
      }
    } catch {}
  }

  if (titles.length < 10) {
    try {
      var res = await fetch('https://techcrunch.com/feed/');
      var xml = await res.text();
      var matches = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.+?)(?:\]\]>)?<\/title>/g)];
      for (var i = 1; i < matches.length && titles.length < 15; i++) {
        var t = matches[i][1].trim();
        if (t.length > 10 && titles.indexOf(t) === -1) titles.push(t);
      }
    } catch {}
  }

  if (titles.length < 10) {
    try {
      var res = await fetch('https://feeds.arstechnica.com/arstechnica/index');
      var xml = await res.text();
      var matches = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.+?)(?:\]\]>)?<\/title>/g)];
      for (var i = 1; i < matches.length && titles.length < 15; i++) {
        var t = matches[i][1].trim();
        if (t.length > 10 && titles.indexOf(t) === -1) titles.push(t);
      }
    } catch {}
  }

  if (titles.length === 0) titles.push('News unavailable');
  return titles;
}

// ── 国内新闻：36kr + IT之家 + 人民网 + GlobalTimes + CNBC ──────
async function fetchChineseNews() {
  var titles = [];

  // 36kr（科技商业）
  try {
    var res = await fetch('https://36kr.com/feed');
    var xml = await res.text();
    var matches = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.+?)(?:\]\]>)?<\/title>/g)];
    for (var i = 1; i < matches.length && titles.length < 20; i++) {
      var t = matches[i][1].trim();
      if (t.length > 4) titles.push(t);
    }
  } catch {}

  // IT之家（科技数码）
  if (titles.length < 20) {
    try {
      var res = await fetch('https://www.ithome.com/rss/');
      var xml = await res.text();
      var matches = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.+?)(?:\]\]>)?<\/title>/g)];
      for (var i = 1; i < matches.length && titles.length < 20; i++) {
        var t = matches[i][1].trim();
        if (t.length > 4 && titles.indexOf(t) === -1) titles.push(t);
      }
    } catch {}
  }

  // 人民网-时政
  if (titles.length < 20) {
    try {
      var res = await fetch('http://www.people.com.cn/rss/politics.xml');
      var xml = await res.text();
      var matches = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.+?)(?:\]\]>)?<\/title>/g)];
      for (var i = 1; i < matches.length && titles.length < 20; i++) {
        var t = matches[i][1].trim();
        if (t.length > 4 && titles.indexOf(t) === -1) titles.push(t);
      }
    } catch {}
  }

  // 人民网-国际
  if (titles.length < 20) {
    try {
      var res = await fetch('http://www.people.com.cn/rss/world.xml');
      var xml = await res.text();
      var matches = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.+?)(?:\]\]>)?<\/title>/g)];
      for (var i = 1; i < matches.length && titles.length < 20; i++) {
        var t = matches[i][1].trim();
        if (t.length > 4 && titles.indexOf(t) === -1) titles.push(t);
      }
    } catch {}
  }

  // 人民网-财经
  if (titles.length < 20) {
    try {
      var res = await fetch('http://www.people.com.cn/rss/finance.xml');
      var xml = await res.text();
      var matches = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.+?)(?:\]\]>)?<\/title>/g)];
      for (var i = 1; i < matches.length && titles.length < 20; i++) {
        var t = matches[i][1].trim();
        if (t.length > 4 && titles.indexOf(t) === -1) titles.push(t);
      }
    } catch {}
  }

  // GlobalTimes（环球时报）
  if (titles.length < 20) {
    try {
      var res = await fetch('https://www.globaltimes.cn/rss/outbrain.xml');
      var xml = await res.text();
      var matches = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.+?)(?:\]\]>)?<\/title>/g)];
      for (var i = 1; i < matches.length && titles.length < 20; i++) {
        var t = matches[i][1].trim();
        if (t.length > 4 && titles.indexOf(t) === -1) titles.push(t);
      }
    } catch {}
  }

  // CNBC（财经补充）
  if (titles.length < 20) {
    try {
      var res = await fetch('https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100727362');
      var xml = await res.text();
      var matches = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.+?)(?:\]\]>)?<\/title>/g)];
      for (var i = 1; i < matches.length && titles.length < 20; i++) {
        var t = matches[i][1].trim();
        if (t.length > 4 && titles.indexOf(t) === -1) titles.push(t);
      }
    } catch {}
  }

  if (titles.length === 0) titles.push('暂无国内新闻数据');
  return titles;
}

// ── AI 调用（NVIDIA 主力 + Workers AI 兜底）────────────────────
// 获取当前有效的 NVIDIA API Key
async function getNvidiaKey(env) {
  var key = await env.KV.get('nvidia_key');
  return key || env.NVIDIA_API_KEY;
}

// 检查 NVIDIA 是否应该降级
// 规则：连续 failCount 次认证失败(401/403/429)才降级，超时/网络错误不算
// 降级后30分钟自动试探恢复
async function isNvidiaDown(env) {
  var fail = await env.KV.get('nvidia_fail', { type: 'json' });
  if (!fail) return false;
  // 没凑够3次连续失败，不算降级
  if (!fail.count || fail.count < 3) return false;
  // 30分钟后自动试探恢复
  var elapsed = Date.now() - (fail.lastFailTs || 0);
  if (elapsed > 1800000) return false;
  return true;
}

// 记录一次认证失败（401/403/429）
async function recordNvidiaFail(env) {
  var fail = await env.KV.get('nvidia_fail', { type: 'json' }) || { count: 0 };
  fail.count = (fail.count || 0) + 1;
  fail.lastFailTs = Date.now();
  await env.KV.put('nvidia_fail', JSON.stringify(fail));
}

// 恢复 NVIDIA（成功一次就清零）
async function markNvidiaUp(env) {
  await env.KV.delete('nvidia_fail');
}

// 主调用函数：NVIDIA → Workers AI 保守降级
async function callAI(env, modelId, messages) {
  var allMessages = [{ role: 'system', content: '你是一个有用的AI助手。请用中文回复。' }];
  for (var i = 0; i < messages.length; i++) allMessages.push(messages[i]);

  // NVIDIA 还没降级，优先用
  if (!(await isNvidiaDown(env))) {
    var nvidiaResult = await callNvidiaRaw(env, modelId, allMessages);
    if (nvidiaResult.ok) {
      return nvidiaResult.text;
    }
    // 只有认证失败才计入降级计数，超时/网络错误不计入
    if (nvidiaResult.status === 401 || nvidiaResult.status === 403 || nvidiaResult.status === 429) {
      await recordNvidiaFail(env);
      // 检查是否已达到降级阈值
      if (await isNvidiaDown(env)) {
        // 连续失败达标，降级到 Workers AI
        var fallbackResult = await callWorkersAI(env, allMessages);
        if (fallbackResult) return fallbackResult + '\n\n⚠️ NVIDIA API 连续失败，已自动切换备用 AI\n用 /key 更新密钥可恢复';
        return '❌ NVIDIA API 失效且备用 AI 不可用，请用 /key 更新密钥';
      }
      // 还没达3次，只记录不降级，返回原始错误
      return nvidiaResult.text;
    }
    return nvidiaResult.text;
  }

  // NVIDIA 已降级，走 Workers AI
  var result = await callWorkersAI(env, allMessages);
  if (result) return result;
  return '❌ 所有 AI 通道不可用，请用 /key 更新 NVIDIA 密钥';
}

// NVIDIA 原始调用
async function callNvidiaRaw(env, modelId, allMessages) {
  try {
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 25000);
    var key = await getNvidiaKey(env);
    var res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
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
      return { ok: false, status: res.status, text: '❌ 模型暂时不可用 (' + res.status + ')\n试试 /model 换一个' };
    }
    var data = await res.json();
    var content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '未收到回复';
    // 调用成功，清除失效标记
    await markNvidiaUp(env);
    return { ok: true, text: content };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, status: 0, text: '⏱ 模型响应超时，请重试或 /model 换一个更快的模型' };
    }
    return { ok: false, status: 0, text: '❌ 请求失败: ' + err.message };
  }
}

// Cloudflare Workers AI 兜底（免费，永不过期）
async function callWorkersAI(env, messages) {
  try {
    if (!env.AI) return null;
    var input = { messages: messages };
    var response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', input);
    if (response && response.response) {
      return response.response;
    }
    return null;
  } catch (e) {
    console.error('Workers AI error:', e);
    return null;
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

// ── Web API ────────────────────────────────────────────────────
async function handleWebAPI(pathname, request, env) {
  var headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  };

  // /api/chat — 聊天
  if (pathname === '/api/chat') {
    try {
      var body = await request.json();
      var messages = body.messages || [];
      var tag = body.model || 'l8';
      var model = MODELS.find(function(m) { return m.tag === tag; }) || MODELS[0];
      var allMessages = [{ role: 'system', content: '你是一个有用的AI助手。请用中文回复。' }];
      for (var i = 0; i < messages.length; i++) allMessages.push(messages[i]);
      var result = await callAI(env, model.id, messages);
      return new Response(JSON.stringify({ ok: true, text: result }), { headers: headers });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: headers });
    }
  }

  // /api/news — 新闻
  if (pathname === '/api/news') {
    try {
      var text = await fetchNews(env);
      return new Response(JSON.stringify({ ok: true, text: text }), { headers: headers });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: headers });
    }
  }

  // /api/model — 切换模型
  if (pathname === '/api/model') {
    try {
      var body = await request.json();
      var tag = body.tag || 'l8';
      var model = MODELS.find(function(m) { return m.tag === tag; }) || MODELS[0];
      return new Response(JSON.stringify({ ok: true, name: model.name }), { headers: headers });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: headers });
    }
  }

  // /api/fast — 测速
  if (pathname === '/api/fast') {
    try {
      var result = await autoSelectFastestWeb(env);
      return new Response(JSON.stringify({ ok: true, text: result }), { headers: headers });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: headers });
    }
  }

  return new Response(JSON.stringify({ ok: false, error: 'unknown api' }), { headers: headers });
}

// Web版测速（不需要chatId）
async function autoSelectFastestWeb(env) {
  var cached = await env.KV.get('speed:fastest', { type: 'json' });
  if (cached && cached.tag && (Date.now() - cached.ts < 3600000)) {
    return '已选择最快模型: ' + cached.name + ' (' + cached.ms + 'ms)\n缓存有效中（1小时内不重测）';
  }
  var results = [];
  var tests = MODELS.map(function(m) {
    return (async function() {
      var start = Date.now();
      try {
        var controller = new AbortController();
        var timeout = setTimeout(function() { controller.abort(); }, 8000);
        var key = await getNvidiaKey(env);
        var res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
          body: JSON.stringify({ model: m.id, messages: [{ role: 'user', content: 'Hi' }], stream: false, temperature: 0, max_tokens: 5 }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        var ms = Date.now() - start;
        results.push({ tag: m.tag, name: m.name, ms: ms, ok: res.ok });
      } catch (e) {
        results.push({ tag: m.tag, name: m.name, ms: 9999, ok: false });
      }
    })();
  });
  await Promise.all(tests);
  results.sort(function(a, b) { return a.ms - b.ms; });
  var fastest = results.find(function(r) { return r.ok; });
  if (!fastest) return '所有模型当前不可用';
  await env.KV.put('speed:fastest', JSON.stringify({ tag: fastest.tag, name: fastest.name, ms: fastest.ms, ts: Date.now() }));
  var report = '测速完成，最快: ' + fastest.name + ' (' + fastest.ms + 'ms)\n\n排名:\n';
  results.forEach(function(r, i) {
    var icon = r.ok ? (r.tag === fastest.tag ? '🥇' : '  ') : '❌';
    report += icon + ' ' + r.name + ': ' + (r.ok ? r.ms + 'ms' : '失败') + '\n';
  });
  return report;
}


