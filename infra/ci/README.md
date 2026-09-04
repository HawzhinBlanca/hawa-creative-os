# Hawa Creative OS — CI/CD Pipeline Documentation

This directory contains the Continuous Assurance pipeline for Hawa Creative OS.

## Overview
The CI/CD pipeline enforces all 19 Acceptance Gates (Gates A through S) across the monorepo:
- **Gate A**: Master Blueprint Package Integrity (418 checks)
- **Gate B**: Zero Secret Leakage Scan
- **Gate C**: Strict NodeNext TypeScript Compilation (14 packages)
- **Gates D–P**: Unit, Orthography, RTL, Contrast, Fault Injection, Chaos & Concurrency Suites (147 tests)
- **Gate H**: Canonical Desk PWA Production Build
- **Gate J**: PostgreSQL 17 DDL Schema, Enums, and Row Level Security (RLS) policies
- **Gate Q**: CycloneDX 1.7 Standard Software Bill of Materials (SBOM)
- **Gate R**: Live API Data-Binding E2E
- **Gate S**: Production Docker Compose Topology & Containerization

## Running Locally
To run the full continuous assurance suite locally:
```bash
./infra/ci/run_ci.sh
```

## GitHub Actions Activation
When publishing to a GitHub remote, copy or symlink the workflow:
```bash
mkdir -p .github/workflows
cp infra/ci/github-workflow.yml .github/workflows/ci.yml
```
*(Note: `.github` is excluded from the local blueprint package to maintain zero-manifest mutation).*
