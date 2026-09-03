# Repository and Vendor Scorecard

Scores are architectural estimates at the 2026-09-03 research freeze, not endorsements or guarantees. “Core” requires evidence plus executable proof.

## Editable systems

| System | Editability | Automation | RTL evidence | Self-host | Maturity evidence | Lock-in | Decision |
|---|---:|---:|---:|---:|---:|---:|---|
| **HyCanvas v0.3.9** | 9 | 8 | 7 | 9 | 6 | 3 | Phase 0 primary candidate |
| Penpot | 9 | 5 | 7 | 9 | 9 | 2 | fallback for mature collaborative/vector route |
| Shotluma | 8 | 7 | 5 | 9 | 5 | 2 | code donor/focused fallback |
| Tela | 8 | 7 | 5 | 10 | 4 | 1 | UI/interaction donor, not backend/core |
| Artboard | 7 | 8 | 3 | 10 | 2 | 1 | schema/determinism ideas only |
| VibePoster | 7 | 7 | 3 | 8 | 2 | 2 | architecture ideas, reject multi-agent core |
| Polotno | 8 | 8 | proof required | 6 | 8 | 7 | emergency commercial fallback |
| Canva APIs | 8 | 6 | vendor-dependent | 1 | 9 | 9 | not selected for private core |

## Design-generation methodology

| Option | Creativity | Editability | Reliability | Decision |
|---|---:|---:|---:|---|
| Flat image generation | 9 | 1 | 3 | prohibited for final factual design |
| Template-only automation | 4 | 9 | 9 | route for recurring formats only |
| Editable-Design reconstruction | 9 | 9 | 7 before integration | selected method |
| Code-native HTML/SVG only | 7 | 9 | 8 | selected topology/fallback, not universal |
| Multi-agent poster graph | 7 | 7 | 4 | unnecessary complexity |

## Workflow

| Option | Durability | Operational burden | Flexibility | Decision |
|---|---:|---:|---:|---|
| Restate | 9 | 8 | 9 | selected |
| Temporal | 10 | 5 | 10 | excellent but heavier than needed |
| Trigger.dev | 8 | 8 | 8 | strong hosted alternative, not office-owned first choice |
| n8n | 6 | 8 | 7 | useful peripheral connector, not core state machine |
| LangGraph/multi-agent | 5 | 5 | 8 | model flow tool, insufficient operational core |
| custom queues/cron | 4 | 7 initially | 5 | false simplicity; rejected |

## Messaging

| Option | Existing-office fit | Official stability | Rich interaction | Decision |
|---|---:|---:|---:|---|
| Hawa Desk | 10 | owned | 10 | canonical |
| Telegram Bot/Mini App | 9 | 9 | 9 | primary bridge |
| WAHA/WhatsApp | 10 | 3 | 7 | optional isolated bridge |
| Slack | office-dependent | 9 | 9 | optional adapter only |
| Matrix/Element | 6 unless office migrates | 9 | 8 | technically good, migration not justified |

## Retrieval

| Option | Structured truth | Multimodal | Office ownership | Decision |
|---|---:|---:|---:|---|
| PostgreSQL + pgvector + Qwen VL | 10 | 9 | 10 | selected initial system |
| Qdrant + relational DB | 5 | 9 | 9 | unnecessary second store initially |
| Pinecone/managed vector | 3 | 8 | 3 | rejected for this private office need |
| Provider file-search/RAG | 2 | 6 | 2 | unsuitable as authoritative memory |

## Rule

Scorecards narrow candidates. The executable proof and office evaluation—not the score—make the final admission decision.
