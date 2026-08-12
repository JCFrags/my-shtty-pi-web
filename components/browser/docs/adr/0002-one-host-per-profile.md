# ADR 0002: One Chromium host per persistent profile

- Status: accepted
- Date: 2026-07-27

## Context

Chromium user-data directories are process-owned and are unsafe to open concurrently. Several Pi agents still need authenticated state, extensions, and password-manager integration from the same named profile.

## Decision

Map each persistent `profileId` to one Chromium host. Agents receive separately owned tabs and browser-session records in that host. Protect startup with a profile lock and serialize profile-global operations. Never launch two hosts against the same data directory.

## Consequences

Shared profile state is intentional and visible. Tab ownership prevents accidental cross-agent actions. Profile launch settings cannot change while the host is active. Persistent hosts are not idle-terminated by default.
