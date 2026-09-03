# Human Review and Approval

## 1. Principle

Human approval is a deliberate quality and accountability checkpoint, not a patch for an uncontrolled agent. The system should make review faster by showing evidence and enabling local edits.

## 2. Review screen

The reviewer sees:

- original message/thread and attachments;
- resolved client/project with evidence;
- locked brief and missing/assumed fields;
- Client DNA version and retrieved references;
- full-size design with variant switcher;
- node/layer inspection and editable-studio launch;
- prior revision and visual/semantic diff;
- hard QA and visual findings;
- model/asset provenance and cost;
- source-package status;
- approve/revise/reject/escalate controls.

## 3. Decisions

### Approve

Approves exactly one immutable design revision and QC report. It does not approve future edits.

### Request revision

Must specify one or more categories and can target nodes/regions. The reviewer chooses:

- AI repair;
- direct manual edit;
- send to designer;
- return for missing facts;
- select another creative direction.

### Reject

Stops production and records whether the concept, content, brand direction, or task itself is rejected.

### Escalate

Routes to a senior designer, language reviewer, manager, or client approver.

## 4. Approval policies

Configurable by client/task/sensitivity:

- one internal reviewer;
- designer + manager;
- native-language reviewer + manager;
- internal + client approval;
- named approver;
- quorum or ordered stages.

Sensitive facts, political content, legal claims, pricing, public emergencies, or newly generated likeness/product imagery can force stronger review.

## 5. Direct edits

A reviewer may open the embedded studio and edit nodes. On save:

1. a new source revision is created;
2. a semantic/node diff is computed;
3. QA reruns on affected checks plus the full critical set;
4. prior approval is invalidated;
5. the revision returns to review.

## 6. Locking

Reviewers may lock:

- exact text nodes;
- official logos;
- approved asset selections;
- specific positions/sizes;
- whole regions;
- a selected concept direction.

AI commands that touch locked nodes fail validation.

## 7. Comments and annotations

Annotations store normalized canvas coordinates, page/artboard, target node when possible, author, text, category, and resolution revision. They survive rendering size changes and are excluded from final outputs.

## 8. Notifications

Telegram/WhatsApp/email notifications may announce review availability. The approval action itself opens Hawa Desk or uses a signed, expiring, authorization-checked interaction. A chat reaction alone is not sufficient for high-risk approval unless explicitly configured.

## 9. Controlled auto-approval

Disabled at launch.

A specific tuple may later qualify:

```text
client + project/task type + template/style version + language + output variant
```

Requirements include substantial recent history, zero critical escapes, low revision rate, no novel imagery/facts, and explicit management enablement. Auto-approved tasks remain sampled for human audit.
