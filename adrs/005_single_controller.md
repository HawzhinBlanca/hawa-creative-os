# ADR-005: Use one bounded controller instead of an agent swarm

**Status:** Accepted  
**Date:** 2026-09-03

## Context

Multiple autonomous agents create duplicated context, unpredictable loops, conflicting actions, and difficult incident analysis. The workflow mostly needs deterministic sequencing with a few intelligent decisions.

## Decision

Use one Creative Director role at bounded points. Domain/workflow code decides tools, permissions, retries, budgets, and side effects. Specialized models are services, not autonomous organizational actors.

## Consequences

Lower cost and failure surface; easier testing and attribution. Some parallel specialist work is still allowed as explicit workflow calls.

## Alternatives considered

LangGraph multi-agent teams and debate loops: rejected. Fully deterministic templates only: insufficient creativity.

## Revisit trigger

Revisit only when executable evidence shows that the decision no longer meets reliability, editability, security, or office-operation goals.
