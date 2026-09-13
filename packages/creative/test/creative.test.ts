import { describe, it, expect } from 'vitest';
import {
  BriefBuilder,
  DesignRouter,
  CreativeDirectorRunner,
  TemplateEngine,
  HoldoutCopyAuditor,
  encodeEditableTransfer,
  renderOperationsToSvg,
} from '../src/index.js';

describe('Creative: Brief, Router & Studio Operations', () => {
  const briefBuilder = new BriefBuilder();
  const router = new DesignRouter();
  const director = new CreativeDirectorRunner();
  const templateEngine = new TemplateEngine();

  it('BriefBuilder: locks exact copy and extracts protected tokens', () => {
    const res = briefBuilder.build({
      taskId: 't-brief-1',
      clientId: 'c-brief-1',
      clientDnaVersion: 1,
      objective: 'Special Discount Offer',
      rawRequestText: 'داشکاندنی بەهارە: ٢٥٬٠٠٠ دینار تا کۆتایی هەفتە',
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.exactCopy.length).toBe(1);
      expect(res.value.exactCopy[0].direction).toBe('rtl');
      expect(res.value.exactCopy[0].protectedTokens.length).toBeGreaterThan(0);
      expect(res.value.exactCopy[0].protectedTokens[0].type).toBe('price');
    }
  });

  it('DesignRouter: routes matched template with high confidence', () => {
    const briefRes = briefBuilder.build({
      taskId: 't-route-1',
      clientId: 'c-route-1',
      clientDnaVersion: 1,
      objective: 'Feed discount',
      rawRequestText: 'داشکاندنی سەرجەم کاڵاکان',
    });

    if (briefRes.ok) {
      const resolution = router.resolveRoute(briefRes.value, [
        { id: 'template_retail_feed', category: 'retail', matchScore: 0.95 },
      ]);
      expect(resolution.route).toBe('template_fill');
      expect(resolution.matchedTemplateId).toBe('template_retail_feed');
      expect(resolution.requiresHumanReview).toBe(false);
    }
  });

  it('CreativeDirectorRunner: generates live editable studio operations with Invariant 4', () => {
    const briefRes = briefBuilder.build({
      taskId: 't-plan-1',
      clientId: 'c-plan-1',
      clientDnaVersion: 1,
      objective: 'Campaign Poster',
      rawRequestText: 'پۆستی نوێ: داشکاندنی بەهارە',
    });

    if (briefRes.ok) {
      const plan = director.createDesignPlan(briefRes.value, ['#164a3a', '#f4ecdd']);
      // Invariant 4: Reference image pixels never enter shipped artifact
      expect(plan.artDirectionReference?.shippedInArtifact).toBe(false);

      const ops = director.generateStudioOperations(briefRes.value, plan, 'logo-sha-1');
      expect(ops.length).toBeGreaterThan(0);
      // Verify text nodes are live and editable (locked: false)
      const textOp = ops.find((o) => o.op === 'addText');
      expect(textOp).toBeDefined();
      expect(textOp?.locked).toBe(false);
    }
  });

  it('TemplateEngine: populates template slots without inventing copy', () => {
    const briefRes = briefBuilder.build({
      taskId: 't-tmpl-1',
      clientId: 'c-tmpl-1',
      clientDnaVersion: 1,
      objective: 'Store Banner',
      rawRequestText: 'بەخێربێن بۆ ئاستەر',
    });

    if (briefRes.ok) {
      const ops = templateEngine.populateTemplate(
        {
          templateId: 'tmpl_1',
          name: 'Hero Banner',
          baseWidth: 1080,
          baseHeight: 1080,
          slots: [
            { nodeId: 'node_title', role: 'headline' },
            { nodeId: 'node_logo', role: 'logo' },
          ],
        },
        briefRes.value,
        'logo-sha-1'
      );

      expect(ops.length).toBe(2);
      expect(ops.some((o) => o.op === 'replaceText' && o.text === 'بەخێربێن بۆ ئاستەر')).toBe(true);

      // Verify HoldoutCopyAuditor audits replaceText operations without dropping them
      const auditor = new HoldoutCopyAuditor();
      const auditRes = auditor.auditCandidateCopy(briefRes.value, { operations: ops as any });
      expect(auditRes.ok).toBe(true);
      if (auditRes.ok) {
        expect(auditRes.value.exactMatch).toBe(true);
      }
    }
  });

  it('encodeEditableTransfer: accepts and normalizes 3-digit hex colors without crashing', async () => {
    const plan = {
      width: 1080,
      height: 1350,
      background: '#fff',
      text: [
        {
          copyIndex: 0,
          x: 60,
          y: 200,
          width: 960,
          height: 100,
          fontSize: 32,
          fontFamily: 'Arial',
          color: '#000',
          align: 'center' as const,
        },
      ],
      shapes: [
        {
          x: 60,
          y: 350,
          width: 960,
          height: 10,
          color: '#f00',
        },
      ],
    };

    const copy = ['Official KAAE Announcement'];
    const result = await encodeEditableTransfer(plan, copy);
    expect(result).toBeDefined();
    expect(result.bytes).toBeInstanceOf(Buffer);
    expect(result.bytes.length).toBeGreaterThan(1000);
    expect(result.manifest.plan.background).toBe('#fff');
  });

  it('HoldoutCopyAuditor: handles briefs where exactCopy is undefined without throwing TypeError', () => {
    const auditor = new HoldoutCopyAuditor();
    const brief: any = {
      taskId: 't-none',
      clientId: 'c-none',
      clientDnaVersion: 1,
      objective: 'No copy test',
      rawRequestText: 'Simple layout without exact copy',
      exactCopy: undefined,
    };
    const auditRes = auditor.auditCandidateCopy(brief, 'Some candidate copy text');
    expect(auditRes.ok).toBe(true);
    if (auditRes.ok) {
      expect(auditRes.value.preservedBlocksCount).toBe(0);
      expect(auditRes.value.exactMatch).toBe(true);
    }
  });

  it('renderOperationsToSvg: escapes XML special characters in attributes to prevent XML malformation', () => {
    const ops: any[] = [
      {
        op: 'addVector',
        nodeId: 'vec_<foo>&"bar"',
        x: 10,
        y: 20,
        source: '<path d="M0 0 L10 10"/>',
      },
      {
        op: 'addText',
        nodeId: 'txt_<title>&"quotes"',
        x: 20,
        y: 40,
        width: 300,
        height: 100,
        text: 'Title & More',
        style: {
          fontSize: 24,
          fontFamily: 'Foo & Bar "Sans"',
          color: '#000000',
        },
      },
    ];

    const svg = renderOperationsToSvg(ops, 1080, 1350);
    expect(svg).toContain('id="vec_&lt;foo&gt;&amp;&quot;bar&quot;"');
    expect(svg).toContain('id="txt_&lt;title&gt;&amp;&quot;quotes&quot;"');
    expect(svg).toContain('font-family="Foo &amp; Bar &apos;Sans&apos;"');
    expect(svg).not.toContain('id="vec_<foo>');
    expect(svg).not.toContain('font-family="Foo & Bar "Sans""');
  });
});
