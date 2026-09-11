#!/usr/bin/env node
import { cmdRecordRanks, parseArgs } from '../src/cli.js';

const { flags } = parseArgs(process.argv.slice(2));
cmdRecordRanks(flags)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  });
