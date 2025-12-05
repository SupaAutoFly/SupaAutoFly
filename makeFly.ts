#!/bin/env -S npx tsx

import { parse } from "yaml";
import * as fs from "node:fs";
import { stringify } from "smol-toml";
import * as dotenv from "dotenv";
import "dotenv/config";
import { splitShellString } from "./splitShellString";
import * as path from "path";
import { execSync } from "node:child_process";
import { replaceInFileSync } from "replace-in-file";
import dedent from "ts-dedent";
import { solve as solveDependencies } from "dependency-solver";
import { sign, verify } from "jsonwebtoken";
import { expandEnvVars } from "./expandEnvVars";

const baseRepo = "https://github.com/supabase/supabase.git";
const baseBranch = "1.25.04";

const gitConfig = "-c advice.detachedHead=false -c core.autocrlf=input";

const org = process.env.FLY_ORG || "personal";

const defaultVm = {
  memory: "1GB",
};

const dockerDir = "./supabase/docker/";
const storageBackend = process.env.STORAGE_BACKEND || "minio";

type FlyConfig = {
  app: string;
  primary_region: string;
  build:
    | {
        image: string;
      }
    | {
        dockerfile: string;
      };
  env: Record<string, string>;
  mounts: Array<{ destination: string; source: string }>;
  files: Array<{ guest_path: string; local_path: string }>;
  services: Array<any>;
  vm: Array<Record<string, any>>;
  processes?: Record<string, string>;
  experimental?: {
    entrypoint?: string[];
    cmd?: string[];
  };
};

type InputContext = {
  prefix: string;
  name: string;
  composeData: any;
  dir: string;
  metadata: any;
};

type Context = InputContext & {
  flyConfig: FlyConfig;
};

type ProcessRunMode =
  | "run"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "stop";

function processRunMode(mode: string): ProcessRunMode | undefined {
  switch (mode) {
    case "run":
    case "hourly":
    case "daily":
    case "weekly":
    case "monthly":
    case "stop":
      return mode;
    default:
      return undefined;
  }
}

type ServiceMetadata = {
  image?: string;
  buildFromRepo?: { repo: string; branch: string; dockerfile?: string };
  ha: boolean;
  env?: { [key: string]: string | number | boolean | undefined };
  secrets?: { [key: string]: true | string };
  suppressPorts?: string[];
  rawPorts?: string[];
  extraPorts?: string[];
  ip?: "flycast";
  extraVolumes?: string[];
  extraDependsOn?: string[];
  skipVolumes?: string[];
  processes?: Record<
    string,
    {
      cmd: string;
      // assumption: processes with a schedule (hourly, ...) perform a task and then quit, deployment will wait for them to terminate by themselves
      mode: ProcessRunMode;
      needsVolume?: boolean;
    }
  >;
  vm?: any;
  postprocess?: ((context: Context) => void)[];
  preprocess?: ((context: InputContext) => void)[];
  extraDeployment?: ((context: Context) => string)[];
  extraContainerSetup?: string;
};

type Metadata = {
  [key: string]: ServiceMetadata;
};

function makeMetadata(prefix: string): Metadata {
  const storageS3Endpoint =
    storageBackend === "minio"
      ? `http://${prefix}-minio.internal:9000`
      : "${STORAGE_S3_ENDPOINT}";
  const storageS3Bucket =
    storageBackend === "minio" ? `${prefix}-storage` : "${STORAGE_S3_BUCKET}";
  return {
    db: {
      ha: false,
      extraPorts: ["${POSTGRES_PORT}:${POSTGRES_PORT}"],
      rawPorts: ["${POSTGRES_PORT}"],
      env: {
        PAGER: "more",
        WALG_S3_PREFIX: "${WALG_S3_PREFIX}",
        WALG_S3_REGION: "${WALG_S3_REGION}",
        WALG_S3_ENDPOINT: "${WALG_S3_ENDPOINT}",
        WALG_SSH_PREFIX: "${WALG_SSH_PREFIX}",
        WALG_SSH_PORT: "${WALG_SSH_PORT:-22}",
        WALG_SSH_USERNAME: "${WALG_SSH_USERNAME}",
        WALG_COMPRESSION_METHOD: "${WALG_COMPRESSION_METHOD:-zstd}",
        WALG_LIBSODIUM_KEY_TRANSFORM: "${WALG_LIBSODIUM_KEY_TRANSFORM:-base64}",
      },
      secrets: {
        WALG_S3_ACCESS_KEY_ID: "${WALG_S3_ACCESS_KEY_ID}",
        WALG_S3_SECRET_ACCESS_KEY: "${WALG_S3_SECRET_ACCESS_KEY}",
        WALG_SSH_PRIVATE_KEY: "${WALG_SSH_PRIVATE_KEY}",
        WALG_LIBSODIUM_KEY: "${WALG_LIBSODIUM_KEY}",
      },
      extraVolumes: [
        "./volumes/db/make-walg.json.sh:/usr/local/bin/make-walg.json.sh",
        "./volumes/db/make-wal-g.conf.sh:/usr/local/bin/make-wal-g.conf.sh",
        "./volumes/db/make-base-backup.sh:/usr/local/bin/make-base-backup.sh",
        "./volumes/db/backup.sql:/usr/local/share/wal-g/backup.sql",
        "./volumes/db/setup-backup.sh:/usr/local/bin/setup-backup.sh",
        "wal-g-logs:/var/log/wal-g",
      ],
      extraContainerSetup: dedent`
          if [ -n "\\$WALG_SSH_PRIVATE_KEY" ]; then
            echo "Setting up SSH private key for WAL-G"
            mkdir -p ~postgres/.ssh
            export WALG_SSH_PRIVATE_KEY_PATH=$(echo ~postgres/.ssh/backup_id)
            echo "\\$WALG_SSH_PRIVATE_KEY" > \\$WALG_SSH_PRIVATE_KEY_PATH
            chmod 600 \\$WALG_SSH_PRIVATE_KEY_PATH
            chown postgres:postgres \\$WALG_SSH_PRIVATE_KEY_PATH
          fi
          echo "Creating ~postgres/.walg.json"
          bash /usr/local/bin/make-walg.json.sh > ~postgres/.walg.json
          echo "Creating /etc/postgresql-custom/wal-g.conf"
          bash /usr/local/bin/make-wal-g.conf.sh > /etc/postgresql-custom/wal-g.conf
          mkdir -p /var/log/wal-g
          chown postgres:postgres /var/log/wal-g
          while [ -e /etc/maintenance_mode ]; do
            echo "Maintenance mode is enabled, deferring database startup"
            sleep 60
          done
          /usr/local/bin/setup-backup.sh "\\$@"
          `,
    },
    auth: {
      ha: true,
    },
    kong: {
      ha: true,
      suppressPorts: ["${KONG_HTTPS_PORT}"],
      env: {
        KONG_DNS_ORDER: "LAST,AAAA,A,CNAME",
        // this is needed in order to make TUS uploads (e.g. from the studio
        // storage dashboard) work behind fly proxy because it forwards the
        // public kong end-point in X-Forwarded-* and not the
        // http://<prefix>-kong.fly.dev:8000/ which will lead to
        // unreachable upload end-points
        // as kong is only reachable via the fly proxy, the headers can be
        // trusted
        KONG_TRUSTED_IPS: "0.0.0.0/0,::/0",
      },
      postprocess: [postprocessKongYml],
    },
    meta: {
      ha: true,
      env: {
        PG_META_HOST: "fly-local-6pn",
      },
    },
    studio: {
      ha: true,
      env: {
        HOSTNAME: "fly-local-6pn",
        SUPABASE_URL: `https://${prefix}-kong.fly.dev`,
        NEXT_PUBLIC_SITE_URL: `https://${prefix}-kong.fly.dev`,
        NEXT_PUBLIC_GOTRUE_URL: `https://${prefix}-kong.fly.dev/auth/v1`,
      },
    },
    analytics: {
      ha: true,
      buildFromRepo: {
        repo: "https://github.com/tvogel/logflare.git",
        branch: "v1.8.11-tv-1",
      },
      env: {
        LOGFLARE_NODE_HOST: `${prefix}-analytics.fly.dev`,
        LOGFLARE_API_KEY: undefined,
        LOGFLARE_LOG_LEVEL: "warn",
        PHX_HTTP_IP: "::",
        PHX_URL_HOST: `${prefix}-analytics.fly.dev`,
      },
      secrets: {
        POSTGRES_BACKEND_URL: true,
        LOGFLARE_PUBLIC_ACCESS_TOKEN: "${LOGFLARE_API_KEY}",
      },
    },
    rest: {
      ha: true,
      env: {
        PGRST_SERVER_HOST: "fly-local-6pn",
        PGRST_LOG_LEVEL: "${PGRST_LOG_LEVEL}",
      },
      secrets: {
        PGRST_DB_URI: true,
      },
    },
    storage: {
      ha: false,
      env: {
        SERVER_HOST: "fly-local-6pn",
        STORAGE_BACKEND: "s3",
        STORAGE_S3_BUCKET: storageS3Bucket,
        STORAGE_S3_MAX_SOCKETS: 200,
        STORAGE_S3_ENDPOINT: storageS3Endpoint,
        STORAGE_S3_FORCE_PATH_STYLE: true,
        STORAGE_S3_REGION:
          storageBackend === "minio" ? "auto" : "${STORAGE_S3_REGION}",
        FILE_STORAGE_BACKEND_PATH: undefined,
        REQUEST_ALLOW_X_FORWARDED_PATH: "true",
        UPLOAD_FILE_SIZE_LIMIT: "${STORAGE_FILE_SIZE_LIMIT:-52428800}",
        UPLOAD_FILE_SIZE_LIMIT_STANDARD: "${STORAGE_FILE_SIZE_LIMIT:-52428800}",
      },
      secrets: {
        AWS_ACCESS_KEY_ID: "${STORAGE_AWS_ACCESS_KEY_ID}",
        AWS_SECRET_ACCESS_KEY: "${STORAGE_AWS_SECRET_ACCESS_KEY}",
      },
      skipVolumes: ["./volumes/storage"],
      extraDependsOn: storageBackend === "minio" ? ["minio"] : [],
    },
    imgproxy: {
      ha: true,
      env: {
        IMGPROXY_BIND: "fly-local-6pn:5001",
        IMGPROXY_LOCAL_FILESYSTEM_ROOT: undefined,
        IMGPROXY_USE_S3: true,
        IMGPROXY_S3_ENDPOINT: storageS3Endpoint,
      },
      secrets: {
        AWS_ACCESS_KEY_ID: "${STORAGE_AWS_ACCESS_KEY_ID}",
        AWS_SECRET_ACCESS_KEY: "${STORAGE_AWS_SECRET_ACCESS_KEY}",
      },
      skipVolumes: ["./volumes/storage"],
    },
    realtime: {
      ha: false,
      buildFromRepo: {
        repo: "https://github.com/tvogel/realtime.git",
        branch: "v2.30.34-tv-1",
      },
      env: {
        ERL_AFLAGS: "-proto_dist inet6_tcp",
        SEED_SELF_HOST: 0,
      },
      // extraVolumes: [ "./volumes/realtime/runtime.exs:/app/releases/2.28.32/runtime.exs" ],
      extraDeployment: [makeRealtimeTenantSetup],
    },
    functions: {
      ha: true,
      env: {
        SUPABASE_URL: `https://${prefix}-kong.fly.dev`,
      },
      secrets: {
        SUPABASE_DB_URL: true,
      },
      extraPorts: ["9000:9000"],
      rawPorts: ["9000"],
      ip: "flycast",
      postprocess: [installEdgeFunctions],
      extraDeployment: [installDeployFunctions],
    },
    minio: {
      ha: false,
      extraContainerSetup: dedent`
        function setup_credentials() {
            while ! mc alias set local http://localhost:9000 \\\${MINIO_ROOT_USER} \\\${MINIO_ROOT_PASSWORD} &>/dev/null; do
                sleep 1
            done
            echo Succeeded setting up Minio alias >&2
            mc admin user add local \\\${STORAGE_AWS_ACCESS_KEY_ID} \\\${STORAGE_AWS_SECRET_ACCESS_KEY}
            mc admin policy attach local readwrite --user \\\${STORAGE_AWS_ACCESS_KEY_ID}
            mc mb local/${prefix}-storage
        }

        setup_credentials &

        args=("\\\$@")
        if [ "\\\${args[1]}" = "/minio-data" ]; then
            args[1]="\\\$(realpath /minio-data)"
        fi
        set -- "\\\${args[@]}"\n
        `,
    },
    "fly-log-shipper": {
      ha: false,
      env: {
        SUPABASE_LOGFLARE_URL: `http://${prefix}-analytics.internal:4000/api/logs`,
      },
      secrets: {
        ORG: org,
        ACCESS_TOKEN: "${FLY_LOG_SHIPPER_ACCESS_KEY}",
        SUPABASE_LOGFLARE_API_KEY: "${LOGFLARE_API_KEY}",
      },
      preprocess: [makeFlyLogShipperConfig],
    },
    supavisor: {
      ha: false,
      rawPorts: ["${POSTGRES_PORT}", "${POOLER_PROXY_PORT_TRANSACTION}"],
    },
    "storage-backup": {
      ha: false,
      vm: {
        // enable if necessary:
        // cpus: 2,
        // memory: "4GB",
        memory: "2GB",
      },
      env: {
        BACKUP_LABEL: "${STORAGE_BACKUP_LABEL:-storage}",
        SOURCE_ENDPOINT: storageS3Endpoint,
        SOURCE_PATH: storageS3Bucket,
        TARGETS: dedent`{
          "primary": {
            "endpoint": "${process.env.STORAGE_BACKUP_S3_ENDPOINT}",
            "path": "${process.env.STORAGE_BACKUP_S3_BUCKET}/${
          process.env.STORAGE_BACKUP_S3_PATH || ""
        }",
            "forget": "${process.env.STORAGE_BACKUP_RETENTION}",
            "compression": "${
              process.env.STORAGE_BACKUP_COMPRESSION || "auto"
            }"
          }
        }`,
        RESTIC_READ_CONCURRENCY: "10",
        RESTIC_RETRY_LOCK: "10m",
        TIGRISFS_EXTRA_ARGS: "--disable-xattr"
      },
      secrets: {
        SOURCE_ACCESS_KEY_ID: "${STORAGE_AWS_ACCESS_KEY_ID}",
        SOURCE_SECRET_ACCESS_KEY: "${STORAGE_AWS_SECRET_ACCESS_KEY}",
        BORG_PASSPHRASE: "${STORAGE_BACKUP_PASSPHRASE}",
        TARGET_SECRETS: dedent`{
          "primary": {
            "access_key_id": "${process.env.STORAGE_BACKUP_S3_ACCESS_KEY_ID}",
            "secret_access_key": "${process.env.STORAGE_BACKUP_S3_SECRET_ACCESS_KEY}",
            "passphrase": "${process.env.STORAGE_BACKUP_PASSPHRASE}"
          }
        }`,
      },
      processes: {
        backup: {
          cmd: "/usr/local/bin/backup.py",
          mode: processRunMode(process.env.STORAGE_BACKUP_SCHEDULE) || "stop",
          needsVolume: true,
        },
        prune: {
          cmd: "/usr/local/bin/backup.py prune",
          mode: processRunMode(process.env.STORAGE_BACKUP_PRUNE_SCHEDULE) || "stop",
          needsVolume: true,
        },
        check: {
          cmd: "/usr/local/bin/backup.py check",
          mode: processRunMode(process.env.STORAGE_BACKUP_CHECK_SCHEDULE) || "stop",
          needsVolume: true,
        },
        maintenance: {
          cmd: "/bin/ash -c 'while sleep 60; do :; done'",
          mode: "stop",
          needsVolume: true,
        },
      },
    },
  };
}

const substitutedServices = { vector: "fly-log-shipper" };

const extraServices: Record<string, any> = {
  "fly-log-shipper": {
    container_name: "fly-log-shipper",
    image: "flyio/log-shipper:latest",
    volumes: [
      "./volumes/fly-log-shipper/debug.toml:/etc/vector/sinks/debug.toml",
      "./volumes/fly-log-shipper/supabase.toml:/etc/vector/sinks/supabase.toml",
    ],
    environment: {
      SUPABASE_PREFIX: "${FLY_PREFIX}",
    },
    // depends_on: {
    //   // analytics: { condition: "service_healthy" }
    // },
  },
};

if (storageBackend === "minio") {
  extraServices.minio = {
    container_name: "minio",
    image: "minio/minio",
    environment: {
      MINIO_ROOT_USER: "${MINIO_ROOT_USER}",
      MINIO_ROOT_PASSWORD: "${MINIO_ROOT_PASSWORD}",
      STORAGE_AWS_ACCESS_KEY_ID: "${STORAGE_AWS_ACCESS_KEY_ID}",
      STORAGE_AWS_SECRET_ACCESS_KEY: "${STORAGE_AWS_SECRET_ACCESS_KEY}",
    },
    ports: ["9001:9001"],
    volumes: ["./volumes/minio:/minio-data"],
    command: ["server", "/minio-data", "--console-address", ":9001"],
  };
}

if (process.env.STORAGE_BACKUP_S3_ENDPOINT) {
  extraServices["storage-backup"] = {
    container_name: "storage-backup",
    image: "ghcr.io/supaautofly/s3resticbackup:main",
    depends_on: {
      // not really but the dependency solver needs a link to order things
      db: { condition: "service_healthy" },
    },
    volumes: [
      "./volumes/storage-backup-cache:/cache",
      "./volumes/storage-backup-config:/config",
    ],
  };
}

function getDockerUserEntrypointAndCmd(image: string) {
  execSync(`docker pull ${image}`, { stdio: "inherit" });
  const dockerInspect = JSON.parse(
    execSync(`docker inspect -f json ${image}`, { encoding: "utf8" })
  );
  const user = dockerInspect[0].Config.User || "root";
  const entrypoint = dockerInspect[0].Config.Entrypoint;
  const cmd = dockerInspect[0].Config.Cmd;
  return { user, entrypoint, cmd };
}

function singleQuote(args: string[]): string {
  if (!args || args.length === 0) return "";
  return "'" + args.map((arg) => arg.replace(/'/g, "\\'")).join("' '") + "'";
}

function doubleQuote(args: string[]): string {
  if (!args || args.length === 0) return "";
  return '"' + args.map((arg) => arg.replace(/"/g, '\\"')).join('" "') + '"';
}

function toVolumeName(volume: string): string {
  return volume.replace(/[^a-z0-9_]/gi, "_");
}

function addFile(
  context: Context,
  localPath: string,
  stagingPath: string,
  containerPath: string
): void {
  if (!fs.statSync(localPath, { throwIfNoEntry: false })?.isFile()) {
    console.warn(`Skipping non-file / missing file ${localPath}`);
    return;
  }

  const { dir, flyConfig } = context;
  const fullStagingPath = `${dir}/${stagingPath}`;
  fs.mkdirSync(path.dirname(fullStagingPath), { recursive: true });
  try {
    fs.copyFileSync(localPath, fullStagingPath);
  } catch (error) {
    console.error(
      `Failed to copy ${localPath} to ${fullStagingPath}: ${error.message}`
    );
    throw error;
  }

  flyConfig.files.push({
    local_path: stagingPath,
    guest_path: containerPath,
  });
}

function makeFly(inputContext: {
  prefix: string;
  name: string;
  composeData: any;
  dir: string;
  metadata: ServiceMetadata;
}): string {
  const { prefix, name, composeData, dir, metadata } = inputContext;

  (metadata?.preprocess ?? []).forEach((preprocess) => {
    preprocess(inputContext);
  });

  const flyConfig: FlyConfig = {
    app: `${prefix}-${name}`,
    primary_region: process.env.FLY_REGION || "fra",
    build: {
      image: metadata?.image ?? composeData.image,
    },
    env: {},
    mounts: [],
    files: [],
    services: [],
    vm: [{
      ...defaultVm,
      ...metadata?.vm,
    }],
  };

  const context: Context = {
    ...inputContext,
    flyConfig,
  };

  function mapUnqualifiedUrl(value: string): string {
    try {
      const url = new URL(value);
      if (url.protocol === "s3:") {
        return value; // Not a URL we map
      }
      const origName = url.hostname;
      if (url.hostname !== "localhost") {
        // allow dev-redirects to localhost
        url.hostname = origName.replace(/^([^.]+)$/, `${prefix}-$1.internal`);
      }
      if (url.hostname === origName) return value;
      const newUrl = url.toString();
      if (!value.endsWith("/") && newUrl.endsWith("/"))
        return newUrl.slice(0, -1);
      return newUrl;
    } catch (error) {
      // Not a URL
    }
    return value;
  }

  function quoteMultilineSecret(value: string): string {
    if (value.includes("\n")) {
      return `"""${value}"""`;
    }
    return value;
  }

  function guessSecret(key: string): boolean {
    return !!key.match(/(pass|secret|key|database_url)/i);
  }

  const guessedSecrets = Object.keys(composeData.environment || {}).filter(
    (key: string) => guessSecret(key)
  );

  flyConfig.env = {
    ...Object.fromEntries(
      Object.entries<string>({
        ...composeData.environment,
        ...metadata?.env,
      })
        .filter(([_, value]: [string, string]) => value !== undefined)
        .filter(
          ([key, _]: [string, string]) =>
            !guessedSecrets.includes(key) &&
            metadata?.secrets?.[key] === undefined
        )
        .map(([variable, value]: [string, string]) => {
          return [variable, mapUnqualifiedUrl(expandEnvVars(value))];
        })
    ),
  };
  if (composeData.entrypoint) {
    let entrypoint = composeData.entrypoint;
    if (typeof entrypoint === "string") {
      entrypoint = splitShellString(entrypoint);
    }
    if (Array.isArray(entrypoint)) {
      entrypoint = entrypoint.map(expandEnvVars);
    }
    flyConfig.experimental = {
      ...flyConfig.experimental,
      entrypoint,
    };
  }

  if (composeData.command) {
    let cmd = composeData.command;
    if (typeof cmd === "string") {
      cmd = splitShellString(cmd);
    }
    if (Array.isArray(cmd)) {
      cmd = cmd.map(expandEnvVars);
    }
    flyConfig.experimental = {
      ...flyConfig.experimental,
      cmd,
    };
  }
  flyConfig.services = (composeData.ports ?? [])
    .concat(metadata?.extraPorts ?? [])
    .map((portMapping: string) => {
      let [hostPort, containerPort, protocol] = portMapping
        .match(/([^:]+):([^\/]+)(?:\/(.*))?/)
        ?.slice(1) ?? [undefined, undefined, undefined];
      if (hostPort === undefined || containerPort === undefined) {
        throw new Error(`Invalid port mapping: ${portMapping}`);
      }
      if (metadata?.suppressPorts?.includes(hostPort)) {
        console.warn(`Suppressing port ${hostPort} for ${name}`);
        return;
      }
      const isRawPort = metadata?.rawPorts?.includes(hostPort);
      hostPort = expandEnvVars(hostPort);
      containerPort = expandEnvVars(containerPort);

      return {
        internal_port: containerPort,
        protocol: protocol ?? "tcp",
        auto_stop_machines: "off",
        auto_start_machines: true,
        min_machines_running: 1,
        ports: [
          {
            ...(!isRawPort && { handlers: ["http"] }),
            port: isRawPort ? hostPort : 80,
            force_https: !isRawPort,
          },
          ...((!isRawPort && [
            {
              handlers: ["tls", "http"],
              port: 443,
            },
          ]) ||
            []),
        ],
      };
    })
    .filter((service: any) => service !== undefined);
  const dockerVolumes = (composeData.volumes ?? [])
    .concat(metadata?.extraVolumes ?? [])
    .map((volume: string) => {
      const [hostPath, containerPath, mode] = expandEnvVars(volume).split(":");
      const fileStat = fs.statSync(dockerDir + hostPath, {
        throwIfNoEntry: false,
      });
      if (fileStat?.isSocket())
        console.warn(`Warning: ${hostPath} is a socket file. Ignoring.`);
      if (fileStat?.isFIFO())
        console.warn(`Warning: ${hostPath} is a FIFO file. Ignoring.`);
      return {
        hostPath,
        containerPath,
        mode,
        isDir: !(
          fileStat?.isFile() ||
          fileStat?.isSocket() ||
          fileStat?.isFIFO()
        ),
        isFile: fileStat?.isFile(),
      };
    });
  dockerVolumes
    .filter((volume: any) => volume.isFile)
    .forEach((volume: any) => {
      if (volume.mode === "z")
        throw new Error('Mode "z" not supported for files.');
      addFile(
        context,
        dockerDir + volume.hostPath,
        volume.hostPath,
        volume.containerPath
      );
    });
  flyConfig.mounts = dockerVolumes
    .filter((volume: any) => volume.isDir)
    .filter((volume: any) => {
      if (metadata?.skipVolumes?.includes(volume.hostPath)) {
        console.warn(`Skipping volume ${volume.hostPath} for ${name}`);
        return false;
      }
      return true;
    })
    .map((volume: any) => {
      if (volume.mode === "z") {
        console.warn(
          `Sharing of volumes between apps is currently not supported. Creating separate volumes for ${volume.hostPath}.`
        );
      }

      const volumeName = toVolumeName(
        `${prefix}_${volume.hostPath.replace(/^.\/volumes\//, "")}`
      );

      if (
        fs
          .statSync(dockerDir + volume.hostPath, { throwIfNoEntry: false })
          ?.isDirectory()
      ) {
        const targetPath = `${dir}/${volume.hostPath}`;
        fs.mkdirSync(targetPath, { recursive: true });
        fs.readdirSync(dockerDir + volume.hostPath, {
          recursive: true,
          encoding: "utf8",
        }).forEach((entry) => {
          addFile(
            context,
            `${dockerDir + volume.hostPath}/${entry}`,
            `${volume.hostPath}/${entry}`,
            `${volume.containerPath}/${entry}`
          );
        });
      }

      return {
        destination: volume.containerPath,
        source: volumeName,
      };
    });

  if (metadata?.buildFromRepo) {
    if (metadata.image)
      throw new Error("Cannot specify both image and buildFromRepo");
    metadata.image = `registry.fly.io/${prefix}-${name}:${metadata.buildFromRepo.branch}`;
    if (
      execSync(`docker images -q ${metadata.image}`, { encoding: "utf-8" }) !==
      ""
    ) {
      console.log(`Image ${metadata.image} already exists. Skipping build.`);
    } else {
      console.log(`Building image for ${name} from repo`);
      const { repo, branch, dockerfile } = metadata.buildFromRepo;
      const buildDir = `${dir}/repo`;
      fs.rmSync(buildDir, { recursive: true, force: true });
      fs.mkdirSync(buildDir, { recursive: true });
      execSync(
        `git clone ${gitConfig} --depth 1 -b ${branch} ${repo} ${buildDir}`,
        { stdio: "inherit" }
      );
      execSync(`docker build -t ${metadata.image} ${buildDir}`, {
        stdio: "inherit",
      });
    }
    flyConfig.build = {
      image: metadata.image,
    };
  }

  let needCustomImage = false;
  if (flyConfig.mounts.length > 0) {
    console.warn(
      `Volume mounts detected for '${name}'. Creating custom image.`
    );
    needCustomImage = true;
  }
  if (metadata?.extraContainerSetup) {
    console.warn(`Extra setup detected for '${name}'. Creating custom image.`);
    needCustomImage = true;
  }
  if (needCustomImage && "image" in flyConfig.build /* for TS, always true */) {
    const { mounts, entrypoint } = generateDockerfile(
      flyConfig.build.image,
      flyConfig.experimental?.entrypoint,
      composeData,
      dir,
      flyConfig.mounts,
      prefix,
      name,
      metadata
    );

    const mountsProcesses = Object.entries(metadata.processes ?? {})
      .filter(
        ([_, processMeta], index) =>
          index === 0 || (processMeta.needsVolume ?? false)
      )
      .map(([processName, _]) => processName);

    flyConfig.mounts = mounts.map((mount: any) => ({
      ...mount,
      ...(mountsProcesses.length > 0
        ? {
            processes: mountsProcesses,
          }
        : {}),
    }));

    if (entrypoint) {
      flyConfig.experimental = {
        ...flyConfig.experimental,
        entrypoint,
      };
    }
    flyConfig.build = {
      dockerfile: "Dockerfile",
    };
  }

  (metadata?.postprocess ?? []).forEach((postprocess: any) => {
    postprocess(context);
  });

  const secrets = {
    ...Object.fromEntries(guessedSecrets.map((key: string) => [key, true])),
    ...metadata?.secrets,
  };
  if (Object.keys(secrets).length > 0) {
    console.log(`Making secrets.ts for ${name}`);
    const secretsTs = fs.openSync(`${dir}/secrets.ts`, "w");
    fs.writeSync(
      secretsTs,
      dedent`#!/bin/env -S npx tsx
      import { execSync } from "node:child_process";
      \n`
    );
    const expandedSecrets: string[] = [];
    for (const secretName in secrets) {
      let secretValue = secrets[secretName];
      if (secretValue === true)
        secretValue = composeData.environment[secretName];
      const secretValueExpanded = quoteMultilineSecret(
        mapUnqualifiedUrl(expandEnvVars(secretValue))
      );
      expandedSecrets.push(`${secretName}=${secretValueExpanded}`);
    }
    fs.writeSync(
      secretsTs,
      dedent`execSync("fly secrets import --stage -a ${prefix}-${name}", {
        input: ${JSON.stringify(expandedSecrets.join("\n"))},
        stdio: ["pipe", "inherit", "inherit"],
      });
      `
    );
    fs.chmodSync(`${dir}/secrets.ts`, 0o755);
  }

  if (metadata?.processes) {
    flyConfig.processes = Object.fromEntries(
      Object.entries(metadata.processes).map(([name, proc]) => [name, proc.cmd])
    );
  }

  fs.writeFileSync(
    `${dir}/deploy.ts`,
    dedent`
        #!/bin/env -S npx tsx
        import { execSync } from "node:child_process";
        import { existsSync } from "node:fs";

        function msleep(n) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
        }
        function sleep(n) {
          msleep(n*1000);
        }

        try {
          execSync("fly status --app ${prefix}-${name}", { stdio: "ignore" });
        } catch (error) {
          execSync("fly apps create --org ${org} --name ${prefix}-${name}", { stdio: "inherit" });
        }

        ${(() => {
          if ((metadata?.image ?? "").startsWith("registry.fly.io/"))
            return dedent`
                    execSync("fly auth docker", { stdio: "inherit" });
                    execSync("docker push ${metadata.image}", { stdio: "inherit" });
                    \n`;
          return "";
        })()}

        if (existsSync("secrets.ts")) {
          execSync("npx tsx secrets.ts", { stdio: "inherit" });
        }

        execSync("fly deploy --no-public-ips --ha=${
          metadata?.ha ?? false
        }", { stdio: "inherit" });
        ${(() => {
          if (metadata?.processes) {
            return dedent`
              const machines = JSON.parse(execSync("fly machines list -j", {
                stdio: ["inherit", "pipe", "inherit"],
                encoding: "utf8"
              }));
              const processMachines = Object.groupBy(
                machines,
                m => m.config.metadata.fly_process_group
              );
              ${Object.entries(metadata.processes)
                .map(([procName, proc]) => {
                  if (proc.mode === "run") return "";
                  return dedent`
                  processMachines["${procName}"]?.forEach(m => {
                    ${(() => {
                      if (proc.mode === "stop") {
                        return dedent`
                          execSync(\`fly machine stop \${m.id}\`, { stdio: "inherit" });
                          `;
                      }
                      // proc.mode with a schedule is expected to terminate by itself
                      return dedent`
                        while (!execSync(\`fly machine status \${m.id}\`, { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8" }).includes("State: stopped")) {
                          console.log("Waiting for initial run of \\"${procName}\\" to complete...");
                          sleep(1);
                        }
                        execSync(\`fly machine stop \${m.id}\`, { stdio: "inherit" });
                        execSync(\`fly machine update \${m.id} --schedule ${proc.mode} --skip-start --yes\`, { stdio: "inherit" });
                        execSync(\`fly machine restart \${m.id}\`, { stdio: "inherit" });
                        `;
                    })()}
                  });
                  `;
                })
                .join("\n")}
              `;
          }
        })()}
        ${(() => {
          if (metadata?.ip === "flycast")
            return dedent`\n
              if (!execSync("fly ips list", {
                stdio: ['inherit', 'pipe', 'inherit'],
                encoding: "utf8"
              }).includes("v6")) {
                execSync("fly ips allocate-v6 --private", { stdio: "inherit" });
              }
              \n
            `;
          if (flyConfig.services.length > 0)
            return dedent`\n
              if (!execSync("fly ips list", {
                stdio: ['inherit', 'pipe', 'inherit'],
                encoding: "utf8"
              }).includes("v6")) {
                execSync("fly ips allocate-v6", { stdio: "inherit" });
              }
              if (!execSync("fly ips list", {
                stdio: ['inherit', 'pipe', 'inherit'],
                encoding: "utf8"
              }).includes("v4")) {
                execSync("fly ips allocate-v4 --shared", { stdio: "inherit" });
              }
              \n
            `;
          return "";
        })()}
        ${(metadata?.extraDeployment ?? [])
          .map((extraDeployment: any) => {
            return extraDeployment(context);
          })
          .join("\n")}
        \n`
  );
  fs.chmodSync(`${dir}/deploy.ts`, 0o755);

  return stringify(flyConfig) + "\n";
}

function generateDockerfile(
  image: string,
  entrypoint: string[],
  composeData: any,
  dir: string,
  mounts: any,
  prefix: string,
  name: string,
  metadata: any
) {
  const {
    user,
    entrypoint: imageEntrypoint,
    cmd,
  } = getDockerUserEntrypointAndCmd(image);
  const dockerfile = `${dir}/Dockerfile`;
  const fd = fs.openSync(dockerfile, "w");
  fs.writeSync(
    fd,
    dedent`
      FROM ${image}

      USER root
      RUN mkdir -p /fly-data

      COPY --chmod=755 --chown=${user} <<'EOF' /usr/local/bin/fly-user-entrypoint.sh
      #!/bin/sh
      exec ${singleQuote(imageEntrypoint)} "$@"
      EOF

      COPY --chmod=755 <<'EOF' /usr/local/bin/fly-entrypoint.sh
      #!/bin/sh
      set -e

      setup_mount() {
        mount_source="$1"
        mount_destination="$2"
        mount_destination_dir="$3"
        if [ ! -e /fly-data/$mount_source ]; then
          if [ -e $mount_destination ]; then
            mv $mount_destination /fly-data/$mount_source
          else
            mkdir -p /fly-data/$mount_source
          fi
        fi
        mkdir -p $mount_destination_dir
        if [ -e $mount_destination ]; then
            rm -rf $mount_destination
        fi
        if command -v mount >/dev/null ; then
          mkdir -p $mount_destination
          mount --bind /fly-data/$mount_source $mount_destination
        else
          ln -s /fly-data/$mount_source $mount_destination
        fi
      }
      \n
      `
  );
  mounts.forEach((mount: any) => {
    fs.writeSync(
      fd,
      dedent`
        setup_mount ${mount.source} ${mount.destination} ${path.dirname(
        mount.destination
      )}\n
        `
    );
  });

  if (metadata?.extraContainerSetup)
    fs.writeSync(fd, "\n" + metadata.extraContainerSetup + "\n");

  if (user !== "root") {
    fs.writeSync(
      fd,
      `exec su \\$(id -u -n ${user}) /usr/local/bin/fly-user-entrypoint.sh "$@"\n`
    );
  } else {
    fs.writeSync(fd, `exec /usr/local/bin/fly-user-entrypoint.sh "$@"\n`);
  }
  fs.writeSync(
    fd,
    dedent`
        EOF

        # only for local development, ignored by fly.io
        VOLUME [ "/fly-data" ]

        ENTRYPOINT ["fly-entrypoint.sh"]\n
        `
  );
  if (cmd) {
    fs.writeSync(fd, `CMD ${JSON.stringify(cmd)}\n`);
  }
  fs.closeSync(fd);
  mounts = [
    {
      destination: "/fly-data",
      source: toVolumeName(`${prefix}_${name}_data`),
    },
  ];
  const newEntrypoint = entrypoint
    ? ["/usr/local/bin/fly-entrypoint.sh", ...entrypoint]
    : undefined;
  return { mounts, entrypoint: newEntrypoint };
}

function postprocessKongYml(context: { prefix: string; dir: string }) {
  const { prefix, dir } = context;
  replaceInFileSync({
    files: `${dir}/volumes/api/kong.yml`,
    from: [
      /realtime-dev\.supabase-realtime/g,
      /http:\/\/(.*):/g,
      new RegExp(String.raw`${prefix}-functions.internal`, "g"),
    ],
    to: [
      "realtime",
      `http://${prefix}-$1.internal:`,
      `${prefix}-functions.flycast`,
    ],
  });
}

function makeFlyLogShipperConfig() {
  const composeYaml = fs.readFileSync(
    "./supabase/docker/volumes/logs/vector.yml",
    "utf8"
  );
  const composeData = parse(composeYaml);

  const transforms = { ...composeData.transforms };
  transforms.project_logs.inputs = ["log_json"];
  transforms.project_logs.source = transforms.project_logs.source.replace(
    ".container_name",
    ".fly.app.name"
  );
  transforms.router.route = Object.fromEntries(
    Object.entries<string>(transforms.router.route).map(
      ([key, value]: [string, string]) => [
        key,
        value.replace("supabase", "${SUPABASE_PREFIX}"),
      ]
    )
  );
  const sinks = Object.fromEntries(
    Object.entries(composeData.sinks).map(
      ([sinkName, sinkDefinition]: [string, any]) => [
        sinkName,
        {
          ...sinkDefinition,
          auth: {
            strategy: "bearer",
            token: "${SUPABASE_LOGFLARE_API_KEY}",
          },
          uri: sinkDefinition.uri
            .replace(/.*\/api\/logs/, "${SUPABASE_LOGFLARE_URL}")
            .replace(/&api_key=.*$/, ""),
        },
      ]
    )
  );
  transforms.rest_logs.source = dedent`
        parsed, err = parse_regex(.event_message, r'\[(?P<time>.*)\] (?P<msg>.*)$')
        if err == null {
          .event_message = parsed.msg
          .timestamp = to_timestamp!(parsed.time)
          .metadata.host = .project
        }\n
        `;

  const flyConfig = {
    transforms,
    sinks,
  };
  fs.mkdirSync("./supabase/docker/volumes/fly-log-shipper", {
    recursive: true,
  });
  fs.writeFileSync(
    "./supabase/docker/volumes/fly-log-shipper/supabase.toml",
    stringify(flyConfig).replaceAll("\\", "\\\\") + "\n"
  );
}

function makeRealtimeTenantSetup(context: {
  prefix: string;
  name: string;
  dir: string;
}) {
  const { prefix, name, dir } = context;
  fs.copyFileSync("./.env", `${dir}/.env`);
  fs.copyFileSync("./makeRealtimeTenant.ts", `${dir}/makeRealtimeTenant.ts`);
  return dedent`
    execSync("npx tsx makeRealtimeTenant.ts ${prefix}-${name}", { stdio: "inherit" });
  `;
}

function installDeployFunctions(context: {
  prefix: string;
  name: string;
  dir: string;
}) {
  const { prefix, name, dir } = context;
  fs.copyFileSync("./deployFunctions.ts", `${dir}/deployFunctions.ts`);
  return "";
}

async function installEdgeFunctionSecrets(
  functionDir: string,
  metadata: Metadata
) {
  const secretsFile = `${functionDir}/.env`;
  if (!fs.existsSync(secretsFile)) return;
  console.log(`Installing secrets for edge functions from ${functionDir}/.env`);
  const secrets = dotenv.parse(fs.readFileSync(secretsFile));
  metadata.secrets = { ...metadata.secrets, ...secrets };
}

function installEdgeFunctions(context: Context) {
  const { prefix, name, dir, metadata, flyConfig } = context;
  if (!process.env.FUNCTIONS_DIR) {
    console.log("No edge function to deploy. Skipping.");
    return;
  }

  fs.writeFileSync(
    `${dir}/.env`,
    `FUNCTIONS_DIR=${process.env.FUNCTIONS_DIR}\n`
  );

  const functionsDir = path.resolve(process.env.FUNCTIONS_DIR);
  if (!fs.existsSync(functionsDir)) {
    console.error(
      `Functions directory ${functionsDir} does not exist. Skipping.`
    );
    return;
  }
  console.log(`Installing edge functions from ${functionsDir}`);
  fs.readdirSync(functionsDir, {
    encoding: "utf8",
    recursive: true,
  }).forEach((entry) => {
    addFile(
      context,
      `${functionsDir}/${entry}`,
      `./volumes/functions/${entry}`,
      `/home/deno/functions/${entry}`
    );
  });

  installEdgeFunctionSecrets(`${dir}/volumes/functions`, metadata);
}

function makeDependencyGraph(
  composeData: any,
  metadata: Metadata
): { [key: string]: string[] } {
  const graph: { [key: string]: string[] } = {};

  for (const serviceName in composeData.services) {
    const service = composeData.services[serviceName];
    if (serviceName in substitutedServices) {
      continue;
    }
    const dependencies: string[] = [];

    if (service.depends_on) {
      dependencies.push(...Object.keys(service.depends_on));
    }
    if (metadata[serviceName]?.extraDependsOn) {
      dependencies.push(...metadata[serviceName].extraDependsOn);
    }
    graph[serviceName] = dependencies.map(
      (dependency: string) => substitutedServices[dependency] ?? dependency
    );
  }
  return graph;
}

function clone() {
  if (fs.existsSync("supabase")) {
    console.log("Supabase repo already exists. Skipping clone.");
    return;
  }
  execSync(
    `git clone ${gitConfig} --filter=blob:none --no-checkout ${baseRepo} supabase`,
    {
      stdio: "inherit",
    }
  );
  execSync(`git sparse-checkout set --cone docker`, {
    stdio: "inherit",
    cwd: "supabase",
  });
  execSync(`git checkout ${baseBranch}`, { stdio: "inherit", cwd: "supabase" });
}

function checkJwt() {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is required");
  }
  try {
    verify(process.env.ANON_KEY ?? "", process.env.JWT_SECRET);
    verify(process.env.SERVICE_ROLE_KEY ?? "", process.env.JWT_SECRET);
  } catch (error) {
    console.log(
      "JWT_SECRET does not match ANON_KEY or SERVICE_ROLE_KEY: regenerating keys."
    );
    const now = Math.floor(Date.now() / 1000);
    const fiveYears = 5 * 365 * 24 * 60 * 60;
    process.env.ANON_KEY = sign(
      {
        role: "anon",
        iss: "supabase",
        iat: now,
        exp: now + fiveYears,
      },
      process.env.JWT_SECRET
    );
    process.env.SERVICE_ROLE_KEY = sign(
      {
        role: "service_role",
        iss: "supabase",
        iat: now,
        exp: now + fiveYears,
      },
      process.env.JWT_SECRET
    );
    replaceInFileSync({
      files: "./.env",
      from: [/ANON_KEY=.*(?:\n|$)/, /SERVICE_ROLE_KEY=.*(?:\n|$)/],
      to: [
        `ANON_KEY=${process.env.ANON_KEY}\n`,
        `SERVICE_ROLE_KEY=${process.env.SERVICE_ROLE_KEY}\n`,
      ],
    });
  }
}

function setupEnvironment(prefix: string) {
  process.env.POSTGRES_HOST = `${prefix}-db.internal`;
  process.env.API_EXTERNAL_URL = `https://${prefix}-kong.fly.dev`;
  process.env.SUPABASE_PUBLIC_URL = `https://${prefix}-kong.fly.dev`;
}

function checkLogShipperAccessKey() {
  if (!process.env.FLY_LOG_SHIPPER_ACCESS_KEY) {
    console.log("Generating new FLY_LOG_SHIPPER_ACCESS_KEY.");
    const token = JSON.parse(
      execSync(
        `flyctl tokens create readonly -j -n "Log shipper for supabase" ${org}`,
        { encoding: "utf8" }
      )
    );
    process.env.FLY_LOG_SHIPPER_ACCESS_KEY = token.token;
    replaceInFileSync({
      files: "./.env",
      from: /FLY_LOG_SHIPPER_ACCESS_KEY=.*(?:\n|$)/,
      to: `FLY_LOG_SHIPPER_ACCESS_KEY=${token.token}\n`,
    });
  }
}

function setup() {
  clone();
  fs.cpSync("./data/", "./supabase/docker/", { recursive: true });
  checkJwt();
  checkLogShipperAccessKey();
}

function fixupComposeData(composeData: any) {
  for (const serviceName in composeData.services) {
    const service = composeData.services[serviceName];
    if (Array.isArray(service.environment)) {
      service.environment = Object.fromEntries(
        service.environment.map((entry: string) => {
          const [key, value] = entry.split("=");
          return [key, value];
        })
      );
    }
  }
}

async function main() {
  setup();

  if (!fs.existsSync("./.env")) {
    console.log(
      "Please create a .env file with the required environment variables (see .env.example)."
    );
    process.exit(1);
  }

  const composeYaml = fs.readFileSync(
    "./supabase/docker/docker-compose.yml",
    "utf8"
  );
  const composeData = parse(composeYaml);
  fixupComposeData(composeData);

  const prefix =
    process.env.FLY_PREFIX || String(composeData.name) || "supabase";
  if (prefix.match(/[^a-z0-9-]/)) {
    throw new Error(
      "Invalid prefix. Only lowercase letters, numbers, and hyphens are allowed."
    );
  }

  setupEnvironment(prefix);
  Object.assign(composeData.services, extraServices);

  const metadata = makeMetadata(prefix);

  const flyDir = "./fly";

  // "recursive: true" to ignore error if already exists
  fs.mkdirSync(flyDir, { recursive: true });

  for (const serviceName in composeData.services) {
    if (serviceName in substitutedServices) {
      console.log(`Skipping ${serviceName}`);
      continue;
    }
    console.log(`Making fly.toml for ${serviceName}`);
    const service = composeData.services[serviceName];
    const flyTomlDir = `${flyDir}/${serviceName}`;
    fs.mkdirSync(flyTomlDir, { recursive: true });
    const flyToml = makeFly({
      prefix,
      name: serviceName,
      composeData: service,
      dir: flyTomlDir,
      metadata: metadata[serviceName],
    });
    const flyTomlPath = `${flyTomlDir}/fly.toml`;
    fs.writeFileSync(flyTomlPath, flyToml);
  }

  const dependencyGraph = makeDependencyGraph(composeData, metadata);
  // console.log(JSON.stringify(dependencyGraph, null, 2));
  const appOrder = solveDependencies(dependencyGraph);

  const deployAllTs = fs.openSync(`${flyDir}/deploy-all.ts`, "w");
  fs.writeSync(
    deployAllTs,
    dedent`
        #!/bin/env -S npx tsx
        import { execSync } from 'child_process';

        process.chdir(__dirname);
        \n`
  );
  appOrder.forEach((serviceName: string) => {
    fs.writeSync(
      deployAllTs,
      dedent`\n
            console.log("Deploying ${serviceName}");
            execSync("npx tsx deploy.ts", {
              stdio: "inherit",
              cwd: "${serviceName}"
            });
            \n`
    );
  });
  fs.writeSync(
    deployAllTs,
    dedent`\n
        console.log(\`
        >>> All apps deployed!
        Find your supabase studio at: https://${prefix}-kong.fly.dev
        \`);
        \n`
  );
  fs.closeSync(deployAllTs);
  fs.chmodSync(`${flyDir}/deploy-all.ts`, 0o755);

  const destroyAllTs = fs.openSync(`${flyDir}/destroy-all.ts`, "w");
  fs.writeSync(
    destroyAllTs,
    dedent`
        #!/bin/env -S npx tsx
        import { spawnSync } from 'child_process';
        import { prompt } from 'enquirer';

        process.chdir(__dirname);

        async function main() {
          console.log(\`** This will tear down the complete supabase deployment and **
          ** DELETE all volumes with all DATA!                        **

          The prefix is: "${prefix}"
          \`)

          const { prefix } = await prompt({
            type: "input",
            name: "prefix",
            message: "Please enter the prefix to proceed (anything else will quit): ",
          });
          if (prefix !== "${prefix}") {
              process.exit(0);
          }
        `
  );
  appOrder.reverse().forEach((serviceName: string) => {
    fs.writeSync(
      destroyAllTs,
      dedent`
            console.log(\`>>> Destroying ${serviceName}\`);
            // ignore failure (might not exist)
            spawnSync("fly", ["apps", "destroy", "${prefix}-${serviceName}", "--yes"], {
              stdio: "inherit",
            });
          \n`
    );
  });
  fs.writeSync(
    destroyAllTs,
    dedent`
    }

    main().catch((err) => {
      const errMsg = "message" in err ? String(err.message) : String(err);
      console.error(\`Aborted\${errMsg ? \` (\${errMsg})\` : ''}.\`);
      process.exit(1);
    });
    `
  );
  fs.closeSync(destroyAllTs);
  fs.chmodSync(`${flyDir}/destroy-all.ts`, 0o755);

  fs.copyFileSync("./.env", `${flyDir}/.env`);
  fs.copyFileSync("./passwdDb.ts", `${flyDir}/passwdDb.ts`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`Failed.\n${error.stack}`);
    process.exit(1);
  });
