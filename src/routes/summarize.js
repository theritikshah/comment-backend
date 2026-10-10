const fs = require('fs');
const path = require('path');
const express = require('express');

const { chat } = require('../services/groq');

const router = express.Router();

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, '../prompts/shipment-summary.txt'), 'utf8');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const pad = (n) => String(n).padStart(2, '0');

/**
 * Accepts `{ Comments, TrackingDetails? }`, `{ comments, trackingDetails? }`, or a bare comments array.
 */
function parseBody(body) {
  if (Array.isArray(body)) return { comments: body, tracking: [] };
  if (!body || typeof body !== 'object') return null;
  const comments = body.Comments || body.comments;
  const tracking = body.TrackingDetails || body.trackingDetails || [];
  if (!Array.isArray(comments) || !Array.isArray(tracking)) return null;
  return { comments, tracking };
}

/**
 * Each comment may be an object ({ Comment, CreatedDate, CreatedBy, ... }) or a plain string.
 * Returns comments oldest first with consecutive duplicates removed, or null if any item is invalid.
 */
function normalizeComments(items) {
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

// "06 Oct 2026" + "6:58PM" -> "2026-10-06 18:58" (sortable, no timezone shift).
function trackingTimestamp(dateStr, timeStr) {
  const d = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/.exec((dateStr || '').trim());
  if (!d || !MONTHS[d[2].toLowerCase()]) return null;
  let stamp = `${d[3]}-${pad(MONTHS[d[2].toLowerCase()])}-${pad(d[1])}`;

  const t = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec((timeStr || '').trim());
  if (t) {
    const hours = (Number(t[1]) % 12) + (t[3].toUpperCase() === 'PM' ? 12 : 0);
    stamp += ` ${pad(hours)}:${t[2]}`;
  }
  return stamp;
}

/**
 * Sorts tracking events oldest first and collapses consecutive repeats of the same
 * activity at the same location (e.g. dozens of "At Destination" scans) into one entry
 * with a date range and count, to keep the prompt small.
 */
function normalizeTracking(items) {
  const events = items
    .filter((e) => e && typeof e === 'object' && typeof e.Activity === 'string' && e.Activity.trim())
    .map((e) => {
      const activity = e.Activity.trim();
      const remarks = typeof e.Remarks === 'string' ? e.Remarks.trim() : '';
      return {
        id: Number(e.Id) || 0,
        at: trackingTimestamp(e.ActivityDate, e.ActivityTime),
        activity,
        location: typeof e.Location === 'string' ? e.Location.trim() : '',
        remarks: remarks && remarks !== activity ? remarks : '',
      };
    })
    // Same-minute events are common; fall back to Id, which increases with insertion order.
    .sort((a, b) => (a.at && b.at && a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.id - b.id));

  const collapsed = [];
  for (const e of events) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.activity === e.activity && prev.location === e.location && !e.remarks) {
      prev.count += 1;
      prev.lastAt = e.at;
    } else {
      collapsed.push({ ...e, count: 1, lastAt: e.at });
    }
  }
  return collapsed;
}

function toPromptInput(comments, tracking) {
  const input = {
    Comments: comments.map((c) => ({ Comment: c.text, CreatedDate: c.rawDate, CreatedBy: c.author })),
  };
  if (tracking.length) {
    input.TrackingDetails = tracking.map((e) => {
      const row = { EventDate: e.at, Status: e.activity };
      if (e.location) row.Location = e.location;
      if (e.remarks) row.Remarks = e.remarks;
      if (e.count > 1) {
        row.RepeatedUntil = e.lastAt;
        row.Occurrences = e.count;
      }
      return row;
    });
  }
  return JSON.stringify(input, null, 2);
}

// Splits the model's Markdown reply into its two labeled sections. Tolerates `**Heading**` or
// `## Heading`, and the Unicode hyphens (e.g. U+2011) the model sometimes writes in "Customer-Friendly".
const SECTIONS_RE =
  /(?:\*\*|#+\s*)Internal Summary:?(?:\*\*)?:?\s*([\s\S]*?)\s*(?:\*\*|#+\s*)Customer[\s‐-―-]Friendly Version:?(?:\*\*)?:?\s*([\s\S]*)$/i;

function parseSections(markdown) {
  const match = SECTIONS_RE.exec(markdown);
  if (!match) return { internalSummary: null, customerSummary: null };
  return { internalSummary: match[1].trim() || null, customerSummary: match[2].trim() || null };
}

router.post('/', async (req, res, next) => {
  const body = parseBody(req.body);
  const comments = body && normalizeComments(body.comments);

  if (!comments || comments.length === 0) {
    return res.status(400).json({
      error:
        'Body must be `{ Comments: [...], TrackingDetails?: [...] }` with a non-empty Comments array ' +
        '(objects with a `Comment` field, or strings)',
    });
  }

  const tracking = normalizeTracking(body.tracking);

  try {
    const reply = await chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: toPromptInput(comments, tracking) },
      ],
      // gpt-oss is a reasoning model; low effort keeps token use (and rate-limit pressure) down
      // and avoids runs where it spends its budget reasoning and returns no answer.
      { temperature: 0.2, reasoning_effort: 'low' }
    );

    const dates = comments.map((c) => c.rawDate).filter(Boolean);
    const latestEvent = tracking[tracking.length - 1];
    res.json({
      ...parseSections(reply),
      markdown: reply,
      meta: {
        commentCount: comments.length,
        firstCommentAt: dates.length ? dates[0] : null,
        lastCommentAt: dates.length ? dates[dates.length - 1] : null,
        authors: [...new Set(comments.map((c) => c.author).filter(Boolean))],
        trackingEventCount: body.tracking.length,
        latestTrackingStatus: latestEvent ? latestEvent.activity : null,
        latestTrackingAt: latestEvent ? latestEvent.lastAt : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
