# Feedback and Governed Learning

## 1. Definition of learning

The system improves through observable, reversible assets:

- routing evidence and mappings;
- Client DNA rules;
- language glossary;
- approved/rejected examples;
- templates and style families;
- retrieval weights;
- model prompts/configuration;
- evaluation cases.

It does not silently rewrite itself or continuously fine-tune from every edit.

## 2. Feedback event

Each event records:

```text
task/client/project
before and after revision
actor/reviewer
category and severity
node/region/asset target
original and corrected values
free-text explanation
scope: one-time | task type | project | client | office
whether factual/brand/visual/preference
explicitness: direct instruction | observed edit | inferred pattern
confidence
evidence links
```

## 3. Categories

- routing/client/project;
- missing/misunderstood requirement;
- exact copy/fact;
- Sorani/Arabic/English terminology;
- logo/brand asset;
- color/font/layout;
- image subject/style/cultural fit;
- crop/mask/composition;
- dimensions/deliverables;
- generated artefact/quality;
- workflow/approval/publication;
- preference-only.

## 4. Immediate use

A revision uses explicit task-scoped correction immediately. The rejected version is excluded from positive retrieval. The corrected approved version becomes eligible positive evidence.

## 5. Rule proposals

Candidate rules are created when:

- an authorized owner explicitly says a persistent rule;
- a correction repeats across enough independent tasks;
- a high-severity escape reveals a missing invariant;
- a template/style has a stable accepted pattern.

A proposal includes natural-language rule, machine representation, scope, conflicts, examples, counterexamples, confidence, and expected affected tasks.

## 6. Human governance

Authorized Client DNA managers may:

- activate;
- narrow scope;
- modify wording/representation;
- defer for more evidence;
- reject;
- supersede/retire.

Activation creates a new immutable Client DNA/rule version and regression cases.

## 7. Contradictions

Conflicting feedback is not averaged blindly. The system considers:

- authority of source;
- recency/effective campaign;
- scope;
- task type;
- explicit versus inferred preference;
- counterexamples.

Unresolved conflicts are shown to a human and do not become active rules.

## 8. Template/style learning

Track by client/project/task/language/template:

- approval without revision;
- revision categories;
- time to approval;
- manual edit distance;
- QA failures;
- reviewer pairwise preferences.

Promote patterns into template/style-family candidates only after human review.

## 9. Retrieval learning

Human reference-usefulness signals can adjust evaluated ranking features. The system does not learn across clients unless a deliberate office-global pattern contains no confidential creative content and is approved.

## 10. Prompt/model learning

Failures become evaluation cases. Prompt or model changes are tested offline and admitted through shadow/canary. Production feedback does not directly edit prompts.

## 11. Fine-tuning threshold

Fine-tuning is considered only when:

- a stable role has a large clean labeled corpus;
- retrieval/templates/prompting have plateaued;
- the failure is measurable and consistent;
- a held-out benchmark shows material improvement;
- rollback and data rights are clear.

For visual style, reference conditioning, templates, adapters, and asset workflows will usually outperform early fine-tuning in reliability and cost.
