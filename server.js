"use strict";

// Canonical Node entrypoint. The browser application lives in app.js and must
// never be executed by Node.
const { app } = require("./server (1).js");

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
server.keepAliveTimeout = 10 * 60 * 1000;
server.headersTimeout = 10 * 60 * 1000 + 1000;
server.requestTimeout = 0;
