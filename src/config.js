module.exports = {
  port: process.env.PORT || 3000,
  groq: {
    apiKey: process.env.GROQ_API_KEY,
    baseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    timeoutMs: Number(process.env.GROQ_TIMEOUT_MS) || 60000,
  },
};
