'use strict';

const { createApp } = require('./app');

const port = Number(process.env.PORT || 8080);
const app = createApp();

app.listen(port, () => {
  console.log(`M-Pesa shop listening on port ${port}`);
});
