#!/usr/bin/env bash
exec > /tmp/std-cloud-setup.log 2>&1
apt-get update -y
apt-get install -y postgresql postgresql-client
exit 0
