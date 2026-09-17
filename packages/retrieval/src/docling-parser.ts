import { createHash } from 'node:crypto';
import type { SHA256, UUID } from '@hawa/contracts';

export interface DocumentChunk {
  chunkId: UUID;
  documentId: UUID;
  pageNumber: number;
  sectionHeader?: string;
  text: string;
  sha256: SHA256;
  tokenCount: number;
  metadata: {
    sourceKind: string;
    sourceId: string;
    mimeType: string;
    coordinates?: { x: number; y: number; width: number; height: number };
  };
}

export interface ParsedDocument {
  documentId: UUID;
  title: string;
  sourceSha256: SHA256;
  chunks: DocumentChunk[];
  tables: Array<{ name: string; rows: Record<string, string>[] }>;
  images: Array<{ storageKey: string; sha256: SHA256; caption?: string }>;
}

export class DoclingParser {
  private computeHash(text: string): SHA256 {
    return createHash('sha256').update(text).digest('hex') as SHA256;
  }

  async parse(
    documentId: UUID,
    rawContent: string | Uint8Array,
    mimeType: string,
    sourceId: string
  ): Promise<ParsedDocument> {
    const text = typeof rawContent === 'string' ? rawContent : new TextDecoder().decode(rawContent);
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    const chunks: DocumentChunk[] = paragraphs.map((para, index) => {
      const pageNumber = Math.floor(index / 5) + 1;
      const sha256 = this.computeHash(para);
      return {
        chunkId: crypto.randomUUID(),
        documentId,
        pageNumber,
        text: para,
        sha256,
        tokenCount: Math.ceil(para.length / 4),
        metadata: {
          sourceKind: 'docling_parsed',
          sourceId,
          mimeType,
          coordinates: { x: 0, y: (index % 5) * 150, width: 600, height: 120 },
        },
      };
    });

    return {
      documentId,
      title: sourceId,
      sourceSha256: this.computeHash(text),
      chunks,
      tables: [],
      images: [],
    };
  }
}
