import type { StudioOperation } from '@hawa/contracts';
import type { DesignBrief } from '@hawa/domain';

export interface TemplateDefinition {
  templateId: string;
  name: string;
  baseWidth: number;
  baseHeight: number;
  slots: Array<{
    nodeId: string;
    role: 'headline' | 'subheadline' | 'logo' | 'hero_image';
    defaultText?: string;
  }>;
}

export class TemplateEngine {
  populateTemplate(template: TemplateDefinition, brief: DesignBrief, logoSha256: string): StudioOperation[] {
    const ops: StudioOperation[] = [];

    for (const slot of template.slots) {
      if (slot.role === 'headline') {
        const headlineBlock = brief.exactCopy.find((c) => c.role === 'headline') || brief.exactCopy[0];
        if (headlineBlock) {
          ops.push({
            op: 'replaceText',
            nodeId: slot.nodeId,
            text: headlineBlock.text,
          });
        }
      } else if (slot.role === 'logo') {
        ops.push({
          op: 'addImage',
          nodeId: slot.nodeId,
          pageId: 'page_primary',
          asset: {
            storageKey: `assets/logos/${logoSha256}.png`,
            sha256: logoSha256,
            mimeType: 'image/png',
          },
          x: 50,
          y: 50,
          width: 200,
          height: 60,
          fit: 'contain',
        });
      }
    }

    return ops;
  }
}
