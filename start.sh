#!/bin/sh
# Start both API server and background worker
node dist/index.js &
node dist/worker.js &
wait
