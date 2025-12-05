# SupaAutoFly

This script automates the self-hosted deployment of the
[supabase](https://supabase.com) stack on [Fly.io](https://fly.io). It clones
the [supabase repository](https://github.com/supabase/supabase), sets up the
necessary configurations, and generates `fly.toml` files for each service
defined in the `docker-compose.yml` file.

## Prerequisites

- Node.js >= 21
- yarn
- Fly.io CLI
- Docker
- git

## Setup

1. Clone this repository and navigate to the project directory:

```sh
git clone https://github.com/SupaAutoFly/SupaAutoFly
cd SupaAutoFly
```

2. Install necessary dependencies:

```sh
yarn
```

## Configuration

The supabase deployment is configured by environment variables in a `.env` file.
Start with the [`.env.example`](.env.example) file as reference:

```sh
cp .env.example .env
```

_Make sure to set up secure secrets._

## Usage

1. Run the script:

```sh
./makeFly.ts
```
or `npx tsx makeFly.ts` if your shell cannot process shebangs.

2. The script will generate a `fly` directory containing `fly.toml` files for
   each service and deployment scripts.

3. To deploy all services, run:

```sh
fly/deploy-all.ts
```
(or `npx tsx fly/deploy-all.ts`)

4. To destroy all services, run:

```sh
fly/destroy-all.ts
```
(or `npx tsx fly/destroy-all.ts`)

## Deploying Edge Functions

The edge functions to deploy are configured by the `FUNCTIONS_DIR` variable and
deployed along with the app initially.

To deploy updated edge functions, you can either destroy the functions app and
deploy it anew, or use the `deployFunctions.ts` script to deploy only the edge
functions without redeploying the entire app:

1. Make sure, the edge function server is deployed and running, e.g. by running
   the `deploy-all.ts` script.
2. Navigate to the generated app directory for the edge function server,
   typically `fly/functions`.
3. Run:
```sh
npx tsx deployFunctions.ts
```

The script will connect to the Fly.io app for the edge functions, upload the new
function definitions to the app's volume and set up the necessary secrets from
the `.env` file in the specified directory.

You can also point the script to a different functions directory (e.g.
`volumes/functions` to redeploy the originally deployed functions) by passing
the functions-dir as an argument:

```sh
npx tsx deployFunctions.ts <my-functions-dir>
```

## Changing the Postgres password
If you need to change the Postgres password after the initial deployment, you
can do so by running the following command:

```sh
cd fly
./passwdDb.ts
```

This will query for a new password (minimum 16 characters, can only contain `[a-zA-Z0-9_]`)
twice, install it in the `db` container and save it to the `.env` file.

_Important:_ You will need to copy the new `.env` file to the SupaAutoFly root
directory and run `./makeFly.ts` and `./fly/deploy-all.ts` again to update all
dependent services with the new password as well!

## Postgres Backups with Point-in-Time Recovery (PITR)

### WAL-G Backup Configuration

You can optionally configure WAL-G for backups: Use either SSH or S3 for
backups, but not both at the same time. (If both are configured, the S3
configuration will be used.) S3 configuration has been tested with Tigris object
storage as offered via fly.io.

When configured, Postgres will automatically archive WAL segments at a
configurable maximum interval (default: 2 minutes).

For creating base-backups, `/usr/local/bin/make-base-backup.sh` is added to the
`db` service and accessible via the shell (to be run as user `postgres`) and the
`backup.make_base_backup()` postgres function. The intent is to set up a `pg_cron`
job in supabase to run this function periodically, e.g. every 24 hours. To run a
nightly base-backup at 04:17 UTC, you could use:

```sql
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule('WAL-G base backup', '17 04 * * *', 'SELECT backup.make_base_backup()');
```


`make-base-backup.sh` will also delete old base backups to keep the number of
backups within the configured limit (default: 7).

WAL-G logs are stored persistently at `/var/log/wal-g`.

### WAL-G Restore Procedure

_Do try this out before you need it in production!_

Base reference: [Continuous PostgreSQL Backups using WAL-G](https://supabase.com/blog/continuous-postgresql-backup-walg)

1. `cd fly/db`
2. Add the following to the `fly.toml` file:
```toml
[[files]]
local_path = "/dev/null"
guest_path = "/etc/maintenance_mode"
```
1. `./deploy.ts`: This will start the app in maintenance mode in which postgres
   will not be started immediately.
2. `fly ssh console`
3. `su postgres`
4. `rm -r ~/data/*` ( ⚠️ this deletes your database but it's broken
   anyway, right!?)
5. `wal-g backup-fetch ~/data LATEST` (or specify an earlier backup listed by
   `wal-g backup-list` if you need to roll back past the latest backup)
6. `touch ~/data/recovery.signal`
7. `exit` (back to root)
8. Optional: Configure point-in-time recovery (otherwise the latest point in
   time will be restored):
    1.  `apt update && apt install nano`
    2.  `nano /etc/postgresql-custom/wal-g.conf`
    3.  Uncomment and set `recovery_target_time`
9.  `rm /etc/maintenance_mode` will end maintenance mode and start the
    postgres service. Startup checks for `/etc/maintenance_mode` only once per
    minute. A delay is expected.
10. Wait for postgres to complete recovery (see `fly logs`). During this time,
    WAL-G will retrieve needed WAL segments from the backup storage.
11. `psql -U postgres` and inspect the restored database
12. `exit` the ssh console
13. Remove the maintenance mode `[[files]]` section from `fly.toml`
14. `./deploy.ts` again to restart the app without maintenance mode.

## Storage Backups (S3 → S3)

If you use supabase storage, you should also back up the storage data. As
supabase storage uses Postgres only for metadata, the above Postgres backup will
not include storage payload.

For storage backups, SupaAutoFly uses
[S3ResticBackup](https://github.com/SupaAutoFly/S3ResticBackup).
To use it, configure the target S3 storage in the `.env` file and set a
backup schedule. You can also configure retention and pruning of old backups and
adjust some Restic internals like compression.

The `storage-backup` app contains four fly "processes":
- `backup`: This process machine performs a single backup run and then exits. It
  is scheduled using `fly machine update --schedule` as configured.
- `prune`: This process machine performs pruning of old backups according to
  the retention policy configured. It is scheduled using `fly machine update
  --schedule` as configured.
- `check`: This process machine performs integrity checks of the restic
  repository. It is scheduled using `fly machine update --schedule` as configured.
- `maintenance`: This process machine is usually stopped. It can be started
  manually using `fly machine start` and picking the `maintenance` machine. This
  machine will start up and be idle such that you can `fly ssh console` into it.
  There, you can use `backup.py mount target-primary` to mount the restic
  backups.

  Don't forget to `fly machine stop` the maintenance machine again to avoid
  unnecessary costs.

  If `restic` fails due to memory exhaustion, please increase the memory of the
  VMs in `makeFly.ts` (see comments there).

  _Do try this out before you need it in production!_

## Customization

You can customize the deployment by modifying the `makeMetadata` function and
the `extraServices` object in the `makeFly.ts` script.

Because this is focussed on deploying Supabase, the script is not designed to
be a generic docker-compose to fly.io converter. Docker-compose is way too rich
in features to make this feasible in the scope of this project.

## Limitations

- The script currently does not convert health checks from the
  `docker-compose.yml` file.
- The dependency resolution is simplistic.
- Edge functions currently do not support the [`config.toml`](https://supabase.com/docs/guides/functions/development-tips#using-configtoml)
  file. There is just a global `VERIFY_JWT` variable for all functions.

## License

This project is licensed under the MIT License.
