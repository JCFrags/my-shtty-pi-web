# ADR 0003: Typed JSON internally; optimized text only at the model edge

- Status: accepted
- Date: 2026-07-27

## Context

The system needs reliable cross-language types, recovery, structured errors, and arbitrary browser metadata. The model benefits from smaller observations, but a compact presentation format is unsuitable as a daemon protocol or persistent schema.

## Decision

Use versioned typed JSON for Rust/TypeScript boundaries, JSON-RPC transports, registry snapshots, and artifact metadata. At the Pi tool result edge, compare Markdown, compact line format, compact JSON, and the official TOON encoder. Select TOON only for regular data when benchmarks show a material reduction.

## Consequences

Transport debugging and schema evolution remain conventional. Formatting can evolve per model family without changing daemon contracts. Complete results remain artifact-backed even when the inline presentation is abbreviated.
