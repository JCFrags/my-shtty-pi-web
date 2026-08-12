.PHONY: bootstrap toolchain-check component-lock-check contracts-generate contracts-check format lint typecheck test-unit docs-check

LOCK_RESOLVED_AT := 2026-08-12T05:00:00Z
QUALITY_AREAS := all typescript python sql shell docs contracts fixtures compose tooling
AREA ?= all
_QUALITY_AREA := $(value AREA)

ifneq ($(filter format lint typecheck test-unit,$(MAKECMDGOALS)),)
ifneq ($(words $(_QUALITY_AREA)),1)
$(error unsafe or unknown AREA; select exactly one of: $(QUALITY_AREAS))
endif
ifeq ($(filter $(_QUALITY_AREA),$(QUALITY_AREAS)),)
$(error unsafe or unknown AREA; allowed: $(QUALITY_AREAS))
endif
ifneq ($(strip $(value AC)),)
$(error AC is reserved and unsupported by WX-M0-010 targets)
endif
ifneq ($(strip $(value PROFILE)),)
$(error PROFILE is reserved and unsupported by WX-M0-010 targets)
endif
override AREA := $(_QUALITY_AREA)
export AREA
endif

bootstrap:
	./scripts/toolchain-check --bootstrap

toolchain-check:
	./scripts/toolchain-check --all

component-lock-check:
	./scripts/toolchain-component-lock --resolved-at $(LOCK_RESOLVED_AT) --check

contracts-generate:
	python3 packages/contracts/scripts/generate_types.py

contracts-check:
	packages/contracts/check.sh

format:
	./scripts/quality-check format

lint:
	./scripts/quality-check lint

typecheck:
	./scripts/quality-check typecheck

test-unit:
	./scripts/quality-check test-unit

docs-check:
	./scripts/docs-check
	python3 scripts/docs_check_test.py
