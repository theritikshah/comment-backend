const fs = require('fs');
const path = require('path');
const express = require('express');

const { chat } = require('../services/groq');

const router = express.Router();

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, '../prompts/shipment-summary.txt'), 'utf8');

/**
 * Accepts either the raw comment array or `{ comments: [...] }`.
 * Each item may be a comment object ({ Comment, CreatedDate, CreatedBy, ... }) or a plain string.
 */
function normalizeComments(body) {
  const items = Array.isArray(body) ? body : body && body.comments;
  if (!Array.isArray(items)) return null;

  const comments = [];
  for (const item of items) {
    if (typeof item === 'string') {
      comments.push({ text: item.trim(), date: null, rawDate: null, author: null });
    } else if (item && typeof item === 'object' && typeof item.Comment === 'string') {
      const date = item.CreatedDate ? new Date(item.CreatedDate) : null;
      comments.push({
        text: item.Comment.trim(),
        date: date && !isNaN(date) ? date : null,
        // Keep the original timestamp: it has no timezone, so toISOString() would shift it to UTC.
        rawDate: date && !isNaN(date) ? item.CreatedDate : null,
        author: typeof item.CreatedBy === 'string' ? item.CreatedBy.trim() || null : null,
      });
    } else {
      return null;
    }
  }

  const sorted = comments
    .filter((c) => c.text)
    .sort((a, b) => (a.date && b.date ? a.date - b.date : 0));

  // Drop consecutive duplicates (same text reposted, e.g. double-submits).
  return sorted.filter((c, i) => i === 0 || c.text !== sorted[i - 1].text);
}

function toPromptInput(comments) {
  const rows = comments.map((c) => ({ Comment: c.text, CreatedDate: c.rawDate, CreatedBy: c.author }));
  return JSON.stringify(rows, null, 2);
}

router.post('/', async (req, res, next) => {
  const comments = normalizeComments(req.body);

  if (!comments || comments.length === 0) {
    return res.status(400).json({
      error: 'Body must be a non-empty array of comments (objects with a `Comment` field, or strings), or `{ comments: [...] }`',
    });
  }

  try {
    const reply = await chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: toPromptInput(comments) },
      ],
      // gpt-oss is a reasoning model; low effort keeps token use (and rate-limit pressure) down
      // and avoids runs where it spends its budget reasoning and returns no answer.
      { temperature: 0.2, reasoning_effort: 'low' }
    );

    const dates = comments.map((c) => c.rawDate).filter(Boolean);
    res.json({
      summary: reply.trim(),
      meta: {
        commentCount: comments.length,
        firstCommentAt: dates.length ? dates[0] : null,
        lastCommentAt: dates.length ? dates[dates.length - 1] : null,
        authors: [...new Set(comments.map((c) => c.author).filter(Boolean))],
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
