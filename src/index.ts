#!/usr/bin/env node
const { main } = await import("./cli.js");

await main(process.argv.slice(2));
