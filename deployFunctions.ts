#!/bin/env -S npx tsx

import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as tar from "tar";
import * as dotenv from "dotenv";
import "dotenv/config";
import { startOneMachineIfMissing } from "./deployCommon";

async function deploy(functionDir: string) {
  console.log(`Deploying functions from directory: ${functionDir}`);

  await startOneMachineIfMissing();

  const remoteTar = spawn(
    'fly ssh console -C "tar xzvf - -C /home/deno/functions"',
    {
      shell: true,
      stdio: ["pipe", "inherit", "inherit"],
    }
  );

  tar
    .create(
      {
        gzip: true,
        cwd: functionDir,
        filter: (path) => path !== ".env",
        follow: true,
      },
      fs.readdirSync(functionDir)
    )
    .pipe(remoteTar.stdin);

  await new Promise<void>((resolve, reject) => {
    remoteTar.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Remote tar command failed with exit code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

async function installSecrets(functionDir: string) {
  const secretsFile = `${functionDir}/.env`;
  if (!fs.existsSync(secretsFile)) return;
  console.log(`Installing secrets from ${functionDir}/.env`);
  const secrets = dotenv.parse(fs.readFileSync(secretsFile));
  const secretsInput = Object.entries(secrets)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  execSync("fly secrets import", {
    input: secretsInput,
    stdio: ["pipe", "inherit", "inherit"],
  });
}

async function main() {
  const functionsDir = process.argv[2] || process.env.FUNCTIONS_DIR;
  if (!functionsDir) {
    console.info("Usage: deployFunctions.ts <functionsDir>");
    console.info("Example: deployFunctions.ts ~/project/supabase/functions");
    process.exit(1);
  }
  await deploy(functionsDir);
  await installSecrets(functionsDir);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`Failed.\n${error.stack}`);
    process.exit(1);
  });
