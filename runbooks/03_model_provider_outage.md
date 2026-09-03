# Runbook: Model Provider Outage or Regression

## Outage

- verify provider and local network health;
- pause expensive retries during sustained outage;
- inspect client egress policy;
- switch only to an admitted fallback for the same role;
- preserve completed retrieval/assets/design source;
- route to manual/local mode if no permitted fallback exists.

## Quality regression

Immediate rollback triggers include protected-fact error, client-scope error, schema failure spike, or critical visual-judge regression.

1. Set deployment to `blocked` or prior state in model registry.
2. Restore previous primary exact model/prompt/config.
3. stop canary/shadow mutation paths;
4. identify affected tasks/revisions;
5. rerun hard QA where necessary;
6. open an evaluation incident and add cases.

Do not map a retired model name silently to a new model.
