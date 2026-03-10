#!/bin/env -S npx tsx

import { sign } from "jsonwebtoken";
import { execFileSync } from "child_process";
import "dotenv/config";
import { startOneMachineIfMissing } from "./deployCommon";

const url = "http://localhost:4000/api/tenants";
const claims = {
  iss: "",
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24, // 24 hours expiration
  aud: "",
  sub: "",
};
const token = sign(claims, process.env.JWT_SECRET);

function deleteTenant(data: any) {
  return `curl -sX DELETE ${url}/${data.tenant.name} -H "Authorization: Bearer ${token}" && echo "Tenant ${data.tenant.name} deleted"`;
}

function createTenant(data: any) {
  return `curl -sX POST ${url} -H "Content-Type: application/json" -H "Authorization: Bearer ${token}" -d '${JSON.stringify(data)}' >/dev/null && echo "Tenant ${data.tenant.name} created"`;
}

function singleQuote(str: string) {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runFly(cmd: string, maxRetries = 3) {
  await startOneMachineIfMissing();

  let retries = maxRetries;
  while (retries) {
    try {
      execFileSync(
        "fly",
        ["ssh", "console", "-C", `/bin/sh -c ${singleQuote(cmd)}`],
        { stdio: "inherit" },
      );
      return;
    } catch (e) {
      if (!--retries) throw e;
      console.warn(`Error running command on fly machine, retrying: ${cmd}`);
    }
  }
}

async function main() {
  const tenantName = process.argv[2];
  if (!tenantName) {
    throw new Error("Usage: realtime_tenant.ts <tenant-name>");
  }
  const prefix = tenantName.slice(0, tenantName.indexOf("-realtime"));

  const data = {
    tenant: {
      name: tenantName,
      external_id: tenantName,
      jwt_secret: process.env.JWT_SECRET,
      extensions: [
        {
          type: "postgres_cdc_rls",
          settings: {
            db_name: process.env.POSTGRES_DB,
            db_host: `${prefix}-db.internal`,
            db_user: "supabase_admin",
            db_password: process.env.POSTGRES_PASSWORD,
            db_port: process.env.POSTGRES_PORT,
            region: "us-west-1",
            ssl_enforced: false,
            poll_interval_ms: 100,
            poll_max_record_bytes: 1048576,
          },
        },
      ],
    },
  };

  await runFly(
    `${deleteTenant({ tenant: { name: "realtime-dev" } })}; ${deleteTenant(data)}; ${createTenant(data)}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`Failed.\n${error.stack}`);
    process.exit(1);
  });
