# Sourced by the DB scripts. Superuser psql in one of two modes:
#  - PGHOST set (CI: a PostgreSQL service container; PGHOST/PGPORT/PGUSER/PGPASSWORD): psql over TCP;
#  - otherwise: the local `postgres` OS user (peer auth), as on a dev machine.
pg_admin() {
  if [ -n "${PGHOST:-}" ]; then
    psql -X "$@"
  else
    su postgres -c "psql -X $(printf '%q ' "$@")"
  fi
}
# URL for tools that need one (prisma migrate diff), as the superuser, to database $1.
# Local mode sets a throw-away password first (see pg_admin_url_cleanup).
pg_admin_url() {
  if [ -n "${PGHOST:-}" ]; then
    echo "postgresql://${PGUSER:-postgres}:${PGPASSWORD:-}@${PGHOST}:${PGPORT:-5432}/$1"
  else
    pg_admin -qc "ALTER USER postgres PASSWORD 'localpg'" >/dev/null
    echo "postgresql://postgres:localpg@localhost:5432/$1"
  fi
}
pg_admin_url_cleanup() { [ -n "${PGHOST:-}" ] || pg_admin -qc 'ALTER USER postgres PASSWORD NULL' >/dev/null; }
