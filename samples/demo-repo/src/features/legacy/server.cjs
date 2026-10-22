const fs = require("fs");
const helper = require("./helper.cjs");

module.exports = { serve: () => helper.greet(fs.existsSync(".") ? "server" : "?") };
