# Source Register

**Access/research date:** 2026-09-03 unless otherwise noted.  
The register prioritizes official documentation, source repositories, releases, and implementation files.

## Editable design systems and methods

- HyCanvas repository: https://github.com/hyscaler/HyCanvas
- HyCanvas v0.3.9 release: https://github.com/hyscaler/HyCanvas/releases/tag/v0.3.9
- HyCanvas release README: https://github.com/hyscaler/HyCanvas/blob/v0.3.9/README.md
- HyCanvas Elastic License 2.0: https://github.com/hyscaler/HyCanvas/blob/v0.3.9/LICENSE
- HyCanvas open schema: `packages/schema/src/schema.ts` at frozen candidate commit
- HyCanvas bidi implementation/tests: `packages/text/src/bidi.ts`, `packages/text/src/__tests__/bidi.test.ts`
- HyCanvas generation and tool manifest: `backend/internal/aistudio/generate.go`, `assistant_tools.json`
- Editable-Design: https://github.com/yejy53/Editable-Design
- Penpot: https://github.com/penpot/penpot
- Tela: https://github.com/heyimjames/tela
- Artboard: https://github.com/Metatransformer/artboard
- VibePoster: https://github.com/l1anch1/VibePoster
- WAHA: https://github.com/devlikeapro/waha

## Workflow and observability

- Restate documentation: https://docs.restate.dev/
- Restate releases/changelog: https://github.com/restatedev/restate/releases
- Arize Phoenix: https://phoenix.arize.com/ and https://github.com/Arize-ai/phoenix
- OpenTelemetry: https://opentelemetry.io/docs/

## Models and image systems

- OpenAI model documentation: https://developers.openai.com/api/docs/models
- OpenAI image generation: https://developers.openai.com/api/docs/guides/image-generation
- Google Gemini models/deprecations: https://ai.google.dev/gemini-api/docs/models and https://ai.google.dev/gemini-api/docs/deprecations
- Anthropic models/deprecations: https://docs.anthropic.com/en/docs/about-claude/models and provider deprecation pages
- Black Forest Labs FLUX.2 documentation: https://docs.bfl.ai/
- Recraft API/model documentation: https://www.recraft.ai/docs
- ComfyUI: https://github.com/Comfy-Org/ComfyUI
- Comfy Registry: https://registry.comfy.org/
- Qwen3-VL-Embedding-2B: https://huggingface.co/Qwen/Qwen3-VL-Embedding-2B
- Qwen3-VL-Reranker-2B: https://huggingface.co/Qwen/Qwen3-VL-Reranker-2B

## Retrieval and ingestion

- pgvector: https://github.com/pgvector/pgvector
- Docling: https://github.com/docling-project/docling and https://docling-project.github.io/docling/
- PostgreSQL: https://www.postgresql.org/docs/

## Messaging

- Telegram Bot API: https://core.telegram.org/bots/api
- Telegram Mini Apps: https://core.telegram.org/bots/webapps
- Meta WhatsApp business documentation: https://developers.facebook.com/docs/whatsapp/

## Google integration

- Shared Drives API guidance: https://developers.google.com/workspace/drive/api/guides/about-shareddrives
- Drive upload/search guidance: https://developers.google.com/workspace/drive/api/guides/manage-uploads
- Sheets API: https://developers.google.com/workspace/sheets/api
- Sheets batch update: https://developers.google.com/workspace/sheets/api/guides/batchupdate

## Evidence caveats

- Model availability, prices, limits, and names change; resolve them through the registry at implementation time.
- Repository README claims remain conditional until executable tests pass.
- HyCanvas was source/release/CI inspected but not locally executed in the research environment.
- WAHA is unofficial WhatsApp automation despite being mature open-source software.
- No source proves best Sorani model/editor performance; office tests decide.
