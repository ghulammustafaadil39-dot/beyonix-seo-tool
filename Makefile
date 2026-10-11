# W-09 (QA slice): one-command dev bootstrap.
#
#   make dev        install + migrate + seed + start API, worker, web
#   make test       backend: all vitest projects, tsc, frontend build
#   make coverage   backend coverage on core modules (>=85% gate)
#   make load       50-user / 2-min baseline against a running API
#
# make dev assumes Postgres 16 + Redis 7 on localhost. On this VM:
#   source ~/workspace/.local/qa-env.sh   (before running tests)

.PHONY: dev test coverage load seed build

dev: install migrate seed
	@echo "[make] starting API :4000, worker, web :3000 (Ctrl-C to stop all)"
	@trap 'kill 0' EXIT; \
	  (cd backend && npm start) & \
	  (cd backend && npm run start:worker) & \
	  (cd frontend && npm run dev) & \
	  wait

install:
	cd backend && npm install
	cd frontend && npm install

migrate:
	cd backend && npm run build && node dist/migrate.js

seed:
	cd backend && npm run seed

build:
	cd backend && npm run build
	cd frontend && npm run build

test:
	cd backend && npm test
	cd backend && npx tsc --noEmit
	cd frontend && npm run build

coverage:
	cd backend && npm run test:coverage

load:
	API_BASE=$${API_BASE:-http://localhost:4000} node backend/tests/load/hot-reads.load.mjs
