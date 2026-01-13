#!/bin/env -S npx tsx

import { Command } from 'commander';

import "dotenv/config";

const program = new Command();
program
  .option('-o, --output <type>', 'output format [plain|json|env]', 'plain')
  .parse();

async function main() {
  const format = program.opts().output;

  const apiUrl = `https://${process.env.FLY_PREFIX}-kong.fly.dev/`;

  const variables = {
    "ANON_KEY": process.env.ANON_KEY || "",
    "API_URL": apiUrl,
    "DB_URL": `postgresql://postgres:${process.env.POSTGRES_PASSWORD}@${process.env.FLY_PREFIX}-db.fly.dev:${process.env.POSTGRES_PORT}/${process.env.POSTGRES_DB}`,
    "GRAPHQL_URL": `${apiUrl}graphql/v1`,
    "JWT_SECRET": process.env.JWT_SECRET || "",
    "MCP_URL": `${apiUrl}mcp`,
    // PUBLISHABLE_KEY="sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH"
    // S3_PROTOCOL_ACCESS_KEY_ID="625729a08b95bf1b7ff351a663f3a23c"
    // S3_PROTOCOL_ACCESS_KEY_SECRET="850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907"
    // S3_PROTOCOL_REGION="local"
    // SECRET_KEY="sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz"
    "SERVICE_ROLE_KEY": process.env.SERVICE_ROLE_KEY || "",
    // STORAGE_S3_URL="http://127.0.0.1:54321/storage/v1/s3"
    "STUDIO_URL": apiUrl
  };

  if (format === 'json') {
    console.log(JSON.stringify(variables, null, 2));
  } else if (format === 'env') {
    for (const [key, value] of Object.entries(variables)) {
      console.log(`${key}=${value}`);
    }
  } else {
    for (const [key, value] of Object.entries(variables)) {
      console.log(`${key}: ${value}`);
    }
  }
}

main()
.then(() => process.exit(0))
.catch((err) => {
  const errMsg = "message" in err ? String(err.message) : String(err);
  console.error(`Aborted${errMsg ? ` (${errMsg})` : ''}.`);
  process.exit(1);
});
