/**
 * Polsia AI Proxy — lib/polsia-ai.js
 *
 * All AI features in Kinévia MUST go through this module.
 * Never call Anthropic or OpenAI directly for product AI features.
 * Polsia tracks usage, handles billing, and enables debugging.
 */

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  baseURL: process.env.POLSIA_API_URL || 'https://polsia.com/api/proxy/ai',
  apiKey: process.env.POLSIA_API_KEY,
});

/**
 * Simple chat — Polsia handles model selection (Claude Sonnet by default).
 *
 * @param {string} message - User message
 * @param {object} options
 * @param {string} [options.system] - System prompt
 * @param {number} [options.maxTokens] - Max tokens (default 1500)
 * @param {string} [options.subscriptionId] - Stripe subscription ID for usage tracking
 * @returns {Promise<string>} - Assistant reply text
 */
async function chat(message, options = {}) {
  const headers = {};
  if (options.subscriptionId) {
    headers['X-Subscription-ID'] = options.subscriptionId;
  }

  const response = await anthropic.messages.create(
    {
      max_tokens: options.maxTokens || 1500,
      messages: [{ role: 'user', content: message }],
      system: options.system,
    },
    { headers }
  );

  return response.content[0].text;
}

/**
 * Streaming chat — yields text deltas via callback as they arrive.
 * Caller is responsible for assembling the full reply from deltas.
 *
 * @param {string} message - User message
 * @param {object} options
 * @param {string} [options.system] - System prompt
 * @param {number} [options.maxTokens] - Max tokens (default 1500)
 * @param {string} [options.subscriptionId] - Stripe subscription ID for usage tracking
 * @param {function} options.onDelta - Called with each text delta string
 * @param {AbortSignal} [options.signal] - AbortSignal to cancel the stream
 * @returns {Promise<string>} - Full assembled reply text
 */
async function chatStream(message, options = {}) {
  const headers = {};
  if (options.subscriptionId) {
    headers['X-Subscription-ID'] = options.subscriptionId;
  }

  const stream = await anthropic.messages.stream(
    {
      max_tokens: options.maxTokens || 1500,
      messages: [{ role: 'user', content: message }],
      system: options.system,
    },
    { headers, signal: options.signal }
  );

  let fullText = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      const delta = event.delta.text;
      fullText += delta;
      if (options.onDelta) options.onDelta(delta);
    }
  }

  return fullText;
}

/**
 * Run an autonomous agent with optional MCP tools.
 *
 * @param {string} prompt - Agent task description
 * @param {object} options
 * @param {string[]} [options.mcpServers] - MCP servers to enable (e.g. ['web_search'])
 * @param {string} [options.subscriptionId] - Stripe subscription ID for usage tracking
 * @returns {Promise<object>} - Agent result
 */
async function runAgent(prompt, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.POLSIA_API_KEY}`,
  };
  if (options.subscriptionId) {
    headers['X-Subscription-ID'] = options.subscriptionId;
  }

  const response = await fetch(
    `${process.env.POLSIA_API_URL || 'https://polsia.com/api/proxy/ai'}/agent/run`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt,
        mcpServers: options.mcpServers || [],
      }),
    }
  );

  return response.json();
}

module.exports = { anthropic, chat, chatStream, runAgent };
