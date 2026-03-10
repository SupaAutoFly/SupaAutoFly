import { execFileSync } from "node:child_process";

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function listMachines() {
  return JSON.parse(
    execFileSync("fly", ["machines", "list", "-j"], {
      stdio: ["inherit", "pipe", "inherit"],
      encoding: "utf8",
    }),
  );
}

export async function startOneMachineIfMissing(
  maxRetriesWaiting = 10,
  delayMs = 2000,
) {
  let machines = listMachines();

  if (machines.length === 0) throw Error(`No machines deployed!`);

  if (machines[0].state === "stopped") {
    execFileSync("fly", ["machine", "start", machines[0].id], {
      stdio: "inherit",
    });
    await sleep(delayMs);
  }

  let retries = maxRetriesWaiting;
  while (machines[0].state !== "started") {
    if (!retries) throw Error("Timeout waiting for machine to start.");
    await sleep(delayMs);
    machines = listMachines();
    --retries;
  }
}
