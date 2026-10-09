const express = require('express');
const cors = require('cors');

const healthRouter = require('./routes/health');
const summarizeRouter = require('./routes/summarize');
const { requireAuth } = require('./middleware/auth');
const { notFound, errorHandler } = require('./middleware/errors');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use('/api/health', healthRouter);
app.use('/api/summarize', requireAuth, summarizeRouter);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
