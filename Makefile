.PHONY: bootstrap toolchain-check component-lock-check contracts-generate contracts-check format lint typecheck test-unit docs-check compose-check ci-validate release-check

LOCK_RESOLVED_AT := 2026-08-12T05:00:00Z
QUALITY_AREAS := all typescript python sql shell docs contracts fixtures compose tooling
ACCEPTANCE_IDS := AC-001 AC-002 AC-003 AC-004 AC-005 AC-006 AC-007 AC-008 AC-009 AC-010 AC-011 AC-012 AC-013 AC-014 AC-015 AC-016 AC-017 AC-018 AC-019 AC-020 AC-021 AC-022 AC-023 AC-024 AC-025 AC-026 AC-027 AC-028 AC-029 AC-030
RELEASE_PROFILES := core full model llama-cpu vllm-gpu offline
AREA ?= all
AC ?=
PROFILE ?=
_QUALITY_AREA := $(value AREA)
_RELEASE_AC := $(value AC)
_RELEASE_PROFILE := $(value PROFILE)

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

ifneq ($(filter release-check,$(MAKECMDGOALS)),)
ifneq ($(words $(_RELEASE_AC)),0)
ifneq ($(words $(_RELEASE_AC)),1)
$(error unsafe AC; select exactly one accepted AC ID)
endif
ifeq ($(filter $(_RELEASE_AC),$(ACCEPTANCE_IDS)),)
$(error unknown or unsafe AC; allowed: $(ACCEPTANCE_IDS))
endif
endif
ifneq ($(words $(_RELEASE_PROFILE)),0)
ifneq ($(words $(_RELEASE_PROFILE)),1)
$(error unsafe PROFILE; select exactly one accepted profile)
endif
ifeq ($(filter $(_RELEASE_PROFILE),$(RELEASE_PROFILES)),)
$(error unknown or unsafe PROFILE; allowed: $(RELEASE_PROFILES))
endif
endif
override AC := $(_RELEASE_AC)
override PROFILE := $(_RELEASE_PROFILE)
export AC PROFILE
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

compose-check:
	python3 deploy/compose/validate.py
	python3 -m unittest discover -s deploy/compose/tests -p 'test_*.py'

ci-validate:
	python3 scripts/ci_validate.py
	python3 scripts/ci_validate_test.py

release-check:
	./scripts/release-check
