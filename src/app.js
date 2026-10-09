const express = require('express');
const cors = require('cors');

const healthRouter = require('./routes/health');
const { notFound, errorHandler } = require('./middleware/errors');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use('/api/health', healthRouter);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
