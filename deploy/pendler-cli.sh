#!/bin/bash
# /usr/local/bin/pendler — box admin CLI, run as the service user so files keep their owner.
#   pendler pair [name] | devices | unpair <id> | push-test
set -a; . /etc/pendler/pendler.env; set +a
exec runuser -u pendler -- env TZ=Europe/Berlin /opt/node/bin/node /opt/pendler/current/server/cli.js "$@"
