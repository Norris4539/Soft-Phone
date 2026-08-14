.DEFAULT_GOAL := help
SHELL := /bin/bash

COMPOSE ?= docker compose
ASTERISK := $(COMPOSE) exec -T asterisk asterisk -rx

.PHONY: help setup certs users up down restart logs reload status ps clean \
        dev-server dev-web build check test-e2e

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

setup: ## First-run: .env, certificates and extensions
	@test -f .env || (cp .env.example .env && echo "Created .env — edit it before going live")
	@grep -q 'change-this-to-a-long-random-string' .env \
		&& sed -i.bak "s|JWT_SECRET=change-this-to-a-long-random-string|JWT_SECRET=$$(openssl rand -hex 32)|" .env \
		&& rm -f .env.bak \
		&& echo "Generated a JWT_SECRET" || true
	@$(MAKE) --no-print-directory certs
	@$(MAKE) --no-print-directory users
	@echo
	@echo "Ready.  Next:  make up"

certs: ## Generate a self-signed certificate for local development
	@./scripts/generate-dev-certs.sh

users: ## Render Asterisk config from config/users.json
	@node scripts/manage-users.mjs init 2>/dev/null || node scripts/manage-users.mjs apply

up: ## Build and start the whole stack
	@$(COMPOSE) up -d --build
	@echo
	@echo "Web app:    http://localhost:$${WEB_PORT:-8080}"
	@echo "IMPORTANT:  first, open https://localhost:8089/httpstatus and accept"
	@echo "            the certificate, or SIP registration will fail silently."

down: ## Stop everything
	@$(COMPOSE) down

restart: ## Restart the stack
	@$(COMPOSE) restart

logs: ## Follow logs (make logs SERVICE=asterisk)
	@$(COMPOSE) logs -f $(SERVICE)

reload: ## Re-render extensions and reload Asterisk without dropping calls
	@node scripts/manage-users.mjs apply
	@$(COMPOSE) restart asterisk >/dev/null
	@echo "Asterisk restarted with the new configuration."

status: ## Show registrations, endpoints and active channels
	@echo "--- endpoints ---"        && $(ASTERISK) "pjsip show endpoints"    || true
	@echo "--- registrations ---"    && $(ASTERISK) "pjsip show registrations" || true
	@echo "--- channels ---"         && $(ASTERISK) "core show channels"      || true
	@echo "--- queues ---"           && $(ASTERISK) "queue show"              || true

ps: ## Container status
	@$(COMPOSE) ps

dev-server: ## Run the control server against a running Asterisk
	@cd server && npm install && npm run dev

dev-web: ## Run the web app with hot reload on :5173
	@cd web && npm install && npm run dev

build: ## Build both applications locally
	@cd server && npm install && npm run build
	@cd web && npm install && npm run build

check: ## Typecheck both applications
	@cd server && npm run typecheck
	@cd web && npm run typecheck

test-e2e: ## Two real browsers place a call and verify RTP (see docs/TESTING.md)
	@test -d e2e/node_modules || (cd e2e && npm install)
	@node e2e/call-flow.mjs

clean: ## Stop and remove volumes (destroys voicemail and logs)
	@$(COMPOSE) down -v
