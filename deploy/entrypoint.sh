#!/bin/sh
# Picks the process to run from $PROCESS: api (default), worker, all (api + worker), setup.
set -e
case "${PROCESS:-api}" in
  api) exec node dist/server.js ;;
  worker) exec node dist/worker.js ;;
  all) exec node dist/all.js ;;
  setup) exec node dist/scripts/db-setup.js ;;
  # Setup, then api + worker: the simplest single-service deployment.
  setup-and-all) node dist/scripts/db-setup.js && exec node dist/all.js ;;
  *) echo "Unknown PROCESS: $PROCESS (api, worker, all, setup, setup-and-all)" >&2; exit 1 ;;
esac
