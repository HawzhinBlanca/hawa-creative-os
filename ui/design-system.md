# Hawa Desk Design System

## Character

A calm, dense creative control room: high information clarity, generous preview space, restrained decoration, visible evidence, and strong keyboard operation.

## Layout

- 8 px spacing scale; 4 px only for compact metadata.
- desktop shell: 240 px navigation + flexible content;
- task review: 28% request, 44% canvas, 28% evidence/actions;
- mobile: stacked tabs with sticky primary action;
- maximum readable prose width around 72 characters;
- source copy and assumptions use visibly different containers.

## Typography

- UI: a legible variable sans;
- code/IDs/hashes: monospace;
- Sorani/Arabic content: approved office font with explicit `dir`/`lang` and bidi isolation;
- never fake RTL with text alignment alone.

## Semantic tokens

```text
surface/background/raised
text/primary/secondary/muted
border/default/strong
state/info/success/warning/danger/blocked
focus/ring
client/accent (display only, never sole identifier)
```

## Components

- TaskCard
- StatePill
- ClientBadge
- EvidenceChip
- ExactCopyBlock
- AssumptionBlock
- RevisionSwitcher
- VariantSwitcher
- CanvasFrame
- LayerTargetComment
- QAFinding
- DurableStepTimeline
- CostBadge
- IntegrationHealth
- RuleEvidencePanel
- SafeActionPanel

## Interaction

- Primary action is unique per state.
- Dangerous actions show affected task/client/revision and require a reason.
- Approval displays source and QC hashes in a details section.
- AI suggestions are labeled and never visually indistinguishable from authoritative facts.
- Loading states indicate durable completed/current/next steps, not fake percentages.
- Keyboard shortcuts are discoverable; no canvas-only inaccessible actions.

## Accessibility

WCAG 2.2 AA target, visible focus, 44 px touch targets on mobile, reduced motion, semantic live regions, non-color status labels, and text alternatives for visual QA evidence.
