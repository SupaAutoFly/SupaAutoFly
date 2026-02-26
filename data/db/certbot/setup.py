#!/opt/certbot/.venv/bin/python3

import sqlalchemy
import os
import subprocess
import tempfile
from pathlib import Path
import shutil
import argparse
from base64 import b64encode, b64decode

def fetch_secret(pgc, secret_name):
  result = pgc.execute(sqlalchemy.text('SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=:name'), {"name": secret_name})

  for row in result:
    return row.decrypted_secret;
  return None;

def store_secret(pgc, secret_name, secret, secret_description):
  pgc.execute(sqlalchemy.text('DELETE FROM vault.secrets WHERE name=:name'), {"name": secret_name})
  result = pgc.execute(sqlalchemy.text('SELECT vault.create_secret(:secret, :name, :description)'), {
    "secret": secret,
    "name": secret_name,
    "description": secret_description
  })
  if result.rowcount != 1:
    pgc.rollback()

def main():
  parser = argparse.ArgumentParser()
  args = parser.parse_args()

  pg_host = ''
  pg_port = os.environ['POSTGRES_PORT']
  pg_user = os.environ['POSTGRES_USER']
  pg_pass = os.environ['POSTGRES_PASSWORD']
  pg_db = os.environ['POSTGRES_DB']

  pg = sqlalchemy.create_engine(f"postgresql://{pg_user}:{pg_pass}@{pg_host}:{pg_port}/{pg_db}")

  cert_name = 'db-certbot-state'

  with pg.connect() as pgc:
    cert_state = fetch_secret(pgc, cert_name)

  tempdir = tempfile.mkdtemp()
  letsencrypt_dir = '/etc/letsencrypt'
  letsencrypt_tar = 'letsencrypt.tar.gz'
  letsencrypt_tar_path = f'{tempdir}/{letsencrypt_tar}'
  if cert_state is not None:
    with open(letsencrypt_tar_path, 'wb') as file:
      file.write(b64decode(cert_state))
  if Path(letsencrypt_tar_path).is_file():
    print(f'Found and restored existing config to {letsencrypt_dir}')
    Path(letsencrypt_dir).mkdir(parents=True, exist_ok=True)
    subprocess.run(['/usr/bin/tar', '-C', letsencrypt_dir, '-xzf', letsencrypt_tar_path], check=True)

  subprocess.run(['/opt/certbot/.venv/bin/certbot', 'certonly', '-n', '--agree-tos', '--standalone', '-m', os.environ['DOMAIN_ADMIN_EMAIL'], '-d', os.environ['PUBLIC_HOST']], check=True)
  subprocess.run(['/bin/chown', '-R', 'postgres', '/etc/letsencrypt'], check=True)

  subprocess.run(['/usr/bin/tar', '-C', letsencrypt_dir, '-czf', letsencrypt_tar_path, '.'], check=True)
  with open(letsencrypt_tar_path, 'rb') as file:
    cert_state = b64encode(file.read()).decode('utf-8')

  with pg.connect() as pgc:
    store_secret(pgc, cert_name, cert_state, 'PostgreSQL Certbot State')
    pgc.commit()

  print(f'Stored updated config {letsencrypt_dir} in vault.')

  shutil.rmtree(tempdir)

if __name__ == "__main__":
  main()
