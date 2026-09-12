# CV-18: Keep Learning Governed and Permitted

## Objective & Requirements
Fulfill task **CV-18** and all associated governance requirements:
- **FR-052 (Governed feedback collection)**: Negative feedback and revision instructions captured with explicit human operator provenance; rejected designs prevented from becoming positive training examples.
- **FR-053 (Human sign-off gate)**: Candidate rules mined from human refinements require explicit sign-off by `art_director` or `creative_director` before becoming active Client DNA rules.
- **FR-054 (Semantic conflict detection)**: Automated conflict checking against existing rules (spatial alignment, contradictory affirmative rules) and client prohibited phrases.
- **FR-055 (Data lineage separation)**: Separation of client-owned assets from Canva-derived elements and internal heuristics.
- **FR-066 (Model fine-tuning boundary)**: Restricted data and proprietary vendor elements are strictly excluded from external fine-tuning.
- **FR-067 (Reversible rule rollback)**: Promoted rules can be reversibly rolled back to `DISMISSED` with complete cryptographic audit trails.
- **NFR-007 (Auditability & IP protection)**: Full traceability of every rule from task refinement AST delta to signed DNA snapshot.
- **Invariant #6**: Studio feedback loop requires human sign-off gate before promoting rules to Client DNA.

## Evidence Packets

1. **`POLICY_DATA_LINEAGE_MATRIX.json`**:
   - Governance policies, lineage categorization, permitted and prohibited purposes, and cryptographic retention guarantees.

2. **`RULE_PROMOTION_REJECTION_ROLLBACK.json`**:
   - End-to-end execution of candidate rule mining, human sign-off promotion, dismissals, and reversible rollback with SHA-256 audit hashes.

3. **`CONFLICTING_RULE_TESTS.json`**:
   - Test results demonstrating detection of prohibited phrases, spatial layout contradictions, and negative disclaimer overrides.

4. **`EXCLUDED_DATA_RETRIEVAL_TEST.json`**:
   - Proves zero Canva vendor IP or client assets leak into external fine-tuning or public benchmarks.

## Verification Matrix
- Automated test suites:
  - `apps/core/test/governed-learning-cv18.test.ts` (7/7 passing).
  - `apps/core/test/governed-learning-dna-lifecycle.test.ts` (6/6 passing).
- Entire core test suite: 27/27 test files, 210/210 tests passing.
- Database integrity: 1,449 tasks, 1,449 outbox commands on schema `hawa` (pristine zero test pollution).
- Blueprint validator: `PASS=464, WARN=0, FAIL=0`.
