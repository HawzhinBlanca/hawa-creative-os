# Reproduce this audit

Run from `/Users/hawzhin/Hawdesign`. The four audit scripts create disposable in-process objects and intercept provider traffic. They do not exercise the deployed database or send external messages. They overwrite only this audit directory’s corresponding result files; copy the directory to a new dated evidence run and update output paths before repeating if preserving the original evidence.

```sh
./node_modules/.bin/tsx output/audits/2026-09-12-followup-bug-hunt/baseline-retest.ts
./node_modules/.bin/tsx output/audits/2026-09-12-followup-bug-hunt/adversarial-probes.ts
./node_modules/.bin/tsx output/audits/2026-09-12-followup-bug-hunt/core-probes.ts
./node_modules/.bin/tsx output/audits/2026-09-12-followup-bug-hunt/renderer-probes.ts
./node_modules/.bin/vitest run packages/integrations/test/canva-connect-client.test.ts packages/qa/test/collision-unsolicited.test.ts
```

These are observation probes, not a green/red acceptance suite. A zero script exit means the observation completed, not that Hawa passed. Inspect the JSON fields described in REPORT.md. Provider responses are deliberate local test doubles and do not establish live model access or quality. Core imports some workspace packages through their normal exports; identify the resolved build when repeating.

Independent decoder check: load all PNG pixels using Pillow and read all PDF pages with pypdf in strict mode. The two malicious specimens must fail decoding; the current Hawa validator accepted both. `independent-decoders.json` records actual exceptions.

Runtime GET checks were `/tasks`, `/v1/tasks`, and `/v1/health` through port 8080 without authentication. No auth bypass was attempted. Database aggregates were read from the running `hawa` database, schema `hawa`; no row contents or credentials were copied. Initial default database/schema attempts did not resolve these tables; the final counts use the verified schema.

Browser captures: fresh in-app session, work queue, settings, New Task open only, reverse-tab twice, Escape, mobile viewport 390×844 then reset. No live submission or review action. Browser error log was empty despite the failed queue data load.
