const axios = require('axios');

const { groq } = require('../config');

const client = axios.create({
  baseURL: groq.baseUrl,
  timeout: groq.timeoutMs,
});

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Send a chat completion request to Groq.
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} [options] extra body params, e.g. { temperature, max_tokens, model }
 * @returns {Promise<string>} the assistant's reply text
 */
async function chat(messages, options = {}) {
  if (!groq.apiKey) {
    throw httpError(500, 'GROQ_API_KEY is not set');
  }

  try {
    const { data } = await client.post(
      '/chat/completions',
      { model: groq.model, messages, ...options },
      { headers: { Authorization: `Bearer ${groq.apiKey}` } }
    );
    const choice = data.choices[0];
    const content = (choice.message.content || '').trim();
    if (!content) {
      throw httpError(502, `Groq returned an empty response (finish_reason: ${choice.finish_reason})`);
    }
    return content;
  } catch (err) {
    if (!err.isAxiosError) throw err;
    if (err.response) {
      const detail = err.response.data && (err.response.data.error || err.response.data);
      const message = typeof detail === 'string' ? detail : (detail && detail.message) || JSON.stringify(detail);
      // Pass rate limits through so callers know to retry; everything else is an upstream failure.
      const status = err.response.status === 429 ? 429 : 502;
      throw httpError(status, `Groq API error (${err.response.status}): ${message}`);
    }
    throw httpError(502, `Groq API request failed: ${err.message}`);
  }
}

module.exports = { chat };
