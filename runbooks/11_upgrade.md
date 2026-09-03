# Runbook: Dependency, Model, or Studio Upgrade

1. State the measured problem/opportunity.
2. Pin candidate version/digest and read license/security/migration changes.
3. Restore production-like backup into candidate environment.
4. Run unit/contract/integration, fault injection, security, RTL/editor, model/retrieval, and publication suites relevant to the change.
5. Compare performance/cost/quality to current baseline.
6. create/update ADR and rollback artifact;
7. shadow/canary where applicable;
8. take fresh production backup;
9. deploy and observe;
10. rollback on declared trigger.

No automatic upstream pull, model alias update, browser/font image update, or ComfyUI node update is permitted.
