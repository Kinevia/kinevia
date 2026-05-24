/**
 * Chat AI Kiné — services/chatAI.js
 *
 * Core logic for the Kinévia AI chat assistant.
 * Uses Polsia AI proxy (never direct OpenAI/Anthropic).
 *
 * Task 2/8: System prompt clinique complet intégré.
 * Task 7/8: Rate limiting + robust error handling.
 * Task #1454454: Per-user daily quota (DB-backed, UTC reset) + OpenAI 429 fallback.
 */

const { chat, chatStream } = require('../lib/polsia-ai');
const { chatAISystemPrompt } = require('../prompts/chatAISystemPrompt');
const { v4: uuidv4 } = require('uuid');

// Structured logger — falls back to console if not available in this codebase
let logger;
try { logger = require('../utils/logger'); } catch (_) { logger = null; }

// ── Daily quota (DB-backed, per kiné, UTC midnight reset) ────────────────────
//
// Limit: CHAT_DAILY_LIMIT env var (default 15 messages/day per kiné).
// Why 15: ~100k token budget / ~2k per message ≈ 50 theoretical slots,
// but shared with RAG boot indexing (~64k/boot). 15 is conservative and
// adjustable without a deploy.
//
// To increase the OpenAI rate limit: log in to platform.openai.com →
// Usage limits → "Request increase" for your tier.
// Current tier limits are visible under Settings → Billing → Usage limits.

const DAILY_LIMIT = parseInt(process.env.CHAT_DAILY_LIMIT || '15', 10);
const DB_TIMEOUT_MS = 5000; // 5s hard cap on all quota DB ops

/**
 * Returns today's date in UTC as a 'YYYY-MM-DD' string.
 * Used as the quota_date key — resets naturally at UTC midnight.
 */
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Check daily quota for a kiné. Fail-open: if DB unavailable, returns null (allowed).
 * Returns null if OK to proceed, or an error object if limit reached.
 *
 * @param {object} pool - pg Pool instance
 * @param {number} kineId
 * @returns {Promise<null | { limited: true, used: number, limit: number }>}
 */
async function checkDailyQuota(pool, kineId) {
  try {
    const result = await Promise.race([
      pool.query(
        `SELECT message_count FROM ai_daily_quotas WHERE kine_id = $1 AND quota_date = $2`,
        [kineId, todayUTC()]
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB_TIMEOUT')), DB_TIMEOUT_MS)),
    ]);

    const used = result.rows[0]?.message_count || 0;
    if (used >= DAILY_LIMIT) {
      return { limited: true, used, limit: DAILY_LIMIT };
    }
    return null;
  } catch (err) {
    // Fail-open: quota DB unavailable should not block the user
    const logCtx = { kine_id: kineId, error: err.message };
    if (logger && logger.warn) {
      logger.warn(logCtx, '[chat-ai] Daily quota check failed (fail-open)');
    } else {
      console.warn('[chat-ai] Daily quota check failed (fail-open):', err.message);
    }
    return null;
  }
}

/**
 * Atomically increment today's message count for a kiné.
 * Upsert: inserts row if missing, increments otherwise.
 * Non-blocking: failure here is logged but does not affect the response.
 *
 * @param {object} pool - pg Pool instance
 * @param {number} kineId
 */
async function incrementDailyQuota(pool, kineId) {
  try {
    await Promise.race([
      pool.query(
        `INSERT INTO ai_daily_quotas (kine_id, quota_date, message_count, updated_at)
         VALUES ($1, $2, 1, NOW())
         ON CONFLICT (kine_id, quota_date)
         DO UPDATE SET message_count = ai_daily_quotas.message_count + 1,
                       updated_at    = NOW()`,
        [kineId, todayUTC()]
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB_TIMEOUT')), DB_TIMEOUT_MS)),
    ]);
  } catch (err) {
    const logCtx = { kine_id: kineId, error: err.message };
    if (logger && logger.warn) {
      logger.warn(logCtx, '[chat-ai] Daily quota increment failed (non-fatal)');
    } else {
      console.warn('[chat-ai] Daily quota increment failed (non-fatal):', err.message);
    }
  }
}

// ── Error types ──────────────────────────────────────────────────────────────

const ChatAIErrorType = {
  TIMEOUT: 'TIMEOUT',
  RATE_LIMIT: 'RATE_LIMIT',
  CONTENT_FILTER: 'CONTENT_FILTER',
  DB_ERROR: 'DB_ERROR',
  GENERIC: 'GENERIC',
};

// ── In-memory rate limiter ───────────────────────────────────────────────────

const RATE_LIMIT_PER_KINE = 50;      // messages per hour per kiné
const RATE_LIMIT_GLOBAL = 500;       // messages per hour across all kinés
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Map<kineId, { count, windowStart }>
const perKineCounters = new Map();
// { count, windowStart }
let globalCounter = { count: 0, windowStart: Date.now() };

/**
 * Check rate limits. Returns null if OK, or an error object if limited.
 * @param {string|number} kineId
 * @returns {{ limited: true, retryAfterMs: number, scope: 'kine'|'global' } | null}
 */
function checkRateLimit(kineId) {
  const now = Date.now();

  // Reset global window if expired
  if (now - globalCounter.windowStart >= RATE_LIMIT_WINDOW_MS) {
    globalCounter = { count: 0, windowStart: now };
  }

  // Reset per-kine window if expired
  let kineEntry = perKineCounters.get(kineId);
  if (!kineEntry || now - kineEntry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    kineEntry = { count: 0, windowStart: now };
    perKineCounters.set(kineId, kineEntry);
  }

  // Check global limit first
  if (globalCounter.count >= RATE_LIMIT_GLOBAL) {
    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - globalCounter.windowStart);
    return { limited: true, retryAfterMs, scope: 'global' };
  }

  // Check per-kine limit
  if (kineEntry.count >= RATE_LIMIT_PER_KINE) {
    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - kineEntry.windowStart);
    return { limited: true, retryAfterMs, scope: 'kine' };
  }

  // Increment counters
  globalCounter.count++;
  kineEntry.count++;

  return null;
}

/**
 * Get current rate limit status for a kiné (for informational purposes).
 * @param {string|number} kineId
 * @returns {{ kineUsed: number, kineLimit: number, globalUsed: number, globalLimit: number }}
 */
function getRateLimitStatus(kineId) {
  const now = Date.now();

  const kineEntry = perKineCounters.get(kineId);
  const kineUsed = kineEntry && (now - kineEntry.windowStart < RATE_LIMIT_WINDOW_MS)
    ? kineEntry.count : 0;

  const globalUsed = (now - globalCounter.windowStart < RATE_LIMIT_WINDOW_MS)
    ? globalCounter.count : 0;

  return {
    kineUsed,
    kineLimit: RATE_LIMIT_PER_KINE,
    globalUsed,
    globalLimit: RATE_LIMIT_GLOBAL,
  };
}

// ── AI call with retry ───────────────────────────────────────────────────────

const TIMEOUT_MS = 30000; // 30s per attempt
const MAX_RETRIES = 1;    // retry once on timeout

/**
 * Wrap AI call with timeout.
 */
async function chatWithTimeout(message, options) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TIMEOUT')), TIMEOUT_MS);
    chat(message, options)
      .then(result => { clearTimeout(timer); resolve(result); })
      .catch(err => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Classify an error from the AI proxy.
 */
function classifyAIError(err) {
  const msg = err.message || '';
  const status = err.status || err.statusCode || (err.error && err.error.status);

  if (msg === 'TIMEOUT') return ChatAIErrorType.TIMEOUT;

  // Anthropic SDK rate limit
  // OpenAI 429: rate_limit_exceeded, insufficient_quota, requests_per_day_exceeded, etc.
  if (
    status === 429 ||
    msg.toLowerCase().includes('rate limit') ||
    msg.toLowerCase().includes('rate_limit') ||
    msg.toLowerCase().includes('quota') ||
    msg.toLowerCase().includes('overloaded') ||
    msg.toLowerCase().includes('too many requests')
  ) {
    return ChatAIErrorType.RATE_LIMIT;
  }

  // Content filter / policy violation
  if (
    status === 400 &&
    (msg.toLowerCase().includes('content') ||
     msg.toLowerCase().includes('policy') ||
     msg.toLowerCase().includes('filter') ||
     (err.type && err.type === 'invalid_request_error' && msg.toLowerCase().includes('output blocked')))
  ) {
    return ChatAIErrorType.CONTENT_FILTER;
  }

  // Also catch stop_reason: content_filter in response shape
  if (msg.toLowerCase().includes('content_filter') || msg.toLowerCase().includes('content filter')) {
    return ChatAIErrorType.CONTENT_FILTER;
  }

  return ChatAIErrorType.GENERIC;
}

/**
 * Get AI reply with retry logic on timeout.
 */
async function getChatReplyWithRetry(message, options) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await chatWithTimeout(message, options);
    } catch (err) {
      lastErr = err;
      const errType = classifyAIError(err);

      // Only retry on timeout
      if (errType !== ChatAIErrorType.TIMEOUT || attempt >= MAX_RETRIES) {
        throw err;
      }
      // Brief pause before retry
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw lastErr;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get a reply from the AI assistant.
 *
 * @param {string} message - User message
 * @param {string|null} conversationId - Existing conversation ID, or null for new
 * @param {string|null} subscriptionId - Kiné's Stripe subscription ID for usage tracking
 * @param {string|number|null} kineId - Kiné ID for rate limiting and logging
 * @param {string|null} ragContext - Optional RAG context block to inject into system prompt
 * @returns {Promise<{ reply: string, conversationId: string }>}
 */
async function getChatReply(message, conversationId = null, subscriptionId = null, kineId = null, ragContext = null) {
  const resolvedConversationId = conversationId || uuidv4();

  // Build system prompt: base + optional RAG context block
  const systemPrompt = ragContext
    ? `${chatAISystemPrompt}\n\n---\n\n${ragContext}\n\n---\n\n**Instructions de citation :** Quand tu utilises des informations issues du contexte Kinévia ci-dessus, cite la source entre parenthèses à la fin de la phrase ou du paragraphe concerné, par exemple : *(Source Kinévia : Gainage abdominal — Abdominaux)* ou *(Source Kinévia : Test de Neer — Épaule)*. Si plusieurs sources sont pertinentes, cite-les toutes. Si aucune source du contexte n'est pertinente pour ta réponse, ignore-les et réponds à partir de tes connaissances générales sans mentionner les sources.`
    : chatAISystemPrompt;

  let reply;
  try {
    reply = await getChatReplyWithRetry(message, {
      system: systemPrompt,
      maxTokens: 1500,
      subscriptionId: subscriptionId || undefined,
    });
  } catch (err) {
    const errType = classifyAIError(err);

    // Log with context
    const logCtx = { kine_id: kineId, conversation_id: resolvedConversationId, error_type: errType, error_message: err.message };
    if (logger && logger.error) {
      logger.error(logCtx, '[chat-ai] AI call failed');
    } else {
      console.error('[chat-ai] AI call failed', logCtx);
    }

    // Re-throw with type attached for caller to handle
    const typedErr = new Error(err.message);
    typedErr.chatAIErrorType = errType;
    throw typedErr;
  }

  return {
    reply,
    conversationId: resolvedConversationId,
  };
}

/**
 * Stream an AI reply, calling onDelta for each text chunk.
 * Assembles and returns the full reply once streaming completes.
 * Error classification mirrors getChatReply — throws typed errors.
 *
 * @param {string} message - User message
 * @param {object} options
 * @param {string|null} [options.conversationId] - Existing conversation ID or null
 * @param {string|null} [options.subscriptionId] - Stripe subscription ID for usage tracking
 * @param {string|number|null} [options.kineId] - Kiné ID for logging
 * @param {string|null} [options.ragContext] - Optional RAG context block
 * @param {function} options.onDelta - Called with each text delta string
 * @param {AbortSignal} [options.signal] - AbortSignal to cancel the stream
 * @returns {Promise<{ reply: string, conversationId: string }>}
 */
async function getChatReplyStream(message, options = {}) {
  const { conversationId = null, subscriptionId = null, kineId = null, ragContext = null, onDelta, signal } = options;
  const resolvedConversationId = conversationId || uuidv4();

  const systemPrompt = ragContext
    ? `${chatAISystemPrompt}\n\n---\n\n${ragContext}\n\n---\n\n**Instructions de citation :** Quand tu utilises des informations issues du contexte Kinévia ci-dessus, cite la source entre parenthèses à la fin de la phrase ou du paragraphe concerné, par exemple : *(Source Kinévia : Gainage abdominal — Abdominaux)* ou *(Source Kinévia : Test de Neer — Épaule)*. Si plusieurs sources sont pertinentes, cite-les toutes. Si aucune source du contexte n'est pertinente pour ta réponse, ignore-les et réponds à partir de tes connaissances générales sans mentionner les sources.`
    : chatAISystemPrompt;

  let reply;
  try {
    reply = await chatStream(message, {
      system: systemPrompt,
      maxTokens: 1500,
      subscriptionId: subscriptionId || undefined,
      onDelta,
      signal,
    });
  } catch (err) {
    const errType = classifyAIError(err);

    const logCtx = { kine_id: kineId, conversation_id: resolvedConversationId, error_type: errType, error_message: err.message };
    if (logger && logger.error) {
      logger.error(logCtx, '[chat-ai] AI stream failed');
    } else {
      console.error('[chat-ai] AI stream failed', logCtx);
    }

    const typedErr = new Error(err.message);
    typedErr.chatAIErrorType = errType;
    throw typedErr;
  }

  return {
    reply,
    conversationId: resolvedConversationId,
  };
}

module.exports = {
  getChatReply,
  getChatReplyStream,
  checkRateLimit,
  getRateLimitStatus,
  checkDailyQuota,
  incrementDailyQuota,
  DAILY_LIMIT,
  ChatAIErrorType,
};
