.PHONY: bootstrap toolchain-check component-lock-check format lint typecheck test-unit

LOCK_RESOLVED_AT := 2026-08-12T05:00:00Z

bootstrap:
	./scripts/toolchain-check --bootstrap

toolchain-check:
	./scripts/toolchain-check --all

component-lock-check:
	./scripts/toolchain-component-lock --resolved-at $(LOCK_RESOLVED_AT) --check

format:
	pnpm exec eslint .
	uv run ruff format --check scripts/toolchain*.py

lint:
	pnpm run lint
	uv run ruff check scripts/toolchain*.py
	uv run mypy

typecheck:
	pnpm run typecheck

test-unit:
	pnpm run test:unit
	uv run pytest
