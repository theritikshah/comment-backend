require('dotenv').config();

const app = require('./app');
const { port } = require('./config');

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
