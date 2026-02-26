#!/bin/bash
# First run blocks, then check daily
check_daily() {
  DAILY=$((24*60*60))
  while sleep $DAILY; do
    PREV_LINK=$(readlink /etc/letsencrypt/live/${PUBLIC_HOST}/fullchain.pem)
    /opt/certbot/setup.py
    NEW_LINK=$(readlink /etc/letsencrypt/live/${PUBLIC_HOST}/fullchain.pem)
    if [ "$PREV_LINK" != "$NEW_LINK" ]; then
      echo "Certificate renewal detected: $PREV_LINK -> $NEW_LINK"
      gosu postgres pg_ctl reload
    fi
  done
}

function wait_for_postgres() {
  while ! gosu postgres psql -c 'SELECT 1' &>/dev/null; do
    echo "Waiting for PostgreSQL to accept connections..."
    sleep 1
  done
}

wait_for_postgres
/opt/certbot/setup.py

cat >/etc/postgresql-custom/ssl.conf <<EOF
ssl = on
ssl_cert_file = '/etc/letsencrypt/live/${PUBLIC_HOST}/fullchain.pem'
ssl_key_file = '/etc/letsencrypt/live/${PUBLIC_HOST}/privkey.pem'
ssl_ca_file = '/etc/ssl/certs/ca-certificates.crt'
EOF
chown postgres /etc/postgresql-custom/ssl.conf
echo -e "\\ninclude = '/etc/postgresql-custom/ssl.conf'" >>/etc/postgresql/postgresql.conf

gosu postgres pg_ctl reload
check_daily &
