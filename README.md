---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'a507dd4f-3167-4fde-b9c3-2bf72b2cd9d5'
  PropagateID: 'a507dd4f-3167-4fde-b9c3-2bf72b2cd9d5'
  ReservedCode1: '26b01fe3-c619-44d9-9ab1-0a54fe26a98a'
  ReservedCode2: '26b01fe3-c619-44d9-9ab1-0a54fe26a98a'
---

# AI Chat Bot - Cloudflare Worker

Telegram Bot running on Cloudflare Workers, powered by NVIDIA NIM free API.

## Features

- Multi-model AI chat (7 models, switchable via `/model`)
- Conversation history per user (Cloudflare KV)
- 24/7 online, zero server cost

## Models

| Model | Speed | Description |
|-------|-------|-------------|
| Llama 3.1 8B | ~0.6s | Fast, daily chat |
| Nemotron 3 Nano | ~1s | NVIDIA lightweight |
| GPT-OSS 20B | ~1.3s | OpenAI open-source |
| Gemma 4 31B | ~1.8s | Google open-source |
| DeepSeek V4 Pro | ~5s | 1.6T MoE, strongest reasoning |
| Step 3.7 Flash | ~5.7s | Chinese optimized |
| Nemotron 3 Super | ~7.8s | NVIDIA, 1M context |

## Deploy

1. Clone this repo
2. `npm install -g wrangler && wrangler login`
3. Create KV namespace: `wrangler kv namespace create KV`
4. Set secrets: `wrangler secret put BOT_TOKEN` and `wrangler secret put NVIDIA_API_KEY`
5. Update `wrangler.toml` with your KV namespace ID
6. `wrangler deploy`
7. Set webhook: `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://ai-chat-bot.<YOUR-SUBDOMAIN>.workers.dev"`

## Bot Commands

- `/start` - Welcome message
- `/model` - Switch AI model
- `/clear` - Clear conversation history
- `/current` - Show current model
- `/help` - Help info

> AI生成