"""One bounded PDF job. Input/output are bytes/JSON on pipes, never paths or URLs."""
import hashlib
import io
import importlib.metadata
import json
import signal
import sys

MAX_BYTES = 20 * 1024 * 1024
MAX_PAGES = 40
MAX_TEXT = 1_000_000
MAX_BLOCKS = 10_000
VERSION = 'docling-2.130.0/parse-7.22.0/native-v1'


def extract(data):
    if importlib.metadata.version('docling-slim') != '2.130.0' or importlib.metadata.version('docling-parse') != '7.22.0':
        raise ValueError('DOCUMENT_PARSER_VERSION_MISMATCH')
    if not data or len(data) > MAX_BYTES:
        raise ValueError('DOCUMENT_SIZE_LIMIT')
    if not data.startswith(b'%PDF-'):
        raise ValueError('DOCUMENT_INVALID_PDF')
    from docling.datamodel.base_models import InputFormat, ConversionStatus
    from docling.datamodel.pipeline_options import NativePdfPipelineOptions
    from docling.datamodel.backend_options import PdfBackendOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.backend.docling_parse_backend import DoclingParseDocumentBackend
    from docling.pipeline.native_pdf_pipeline import NativePdfPipeline
    from docling_core.types.io import DocumentStream

    options = NativePdfPipelineOptions(document_timeout=20, parser_threads=1,
        generate_page_images=False, generate_picture_images=False,
        enable_remote_services=False, allow_external_plugins=False)
    converter = DocumentConverter(allowed_formats=[InputFormat.PDF], format_options={
        InputFormat.PDF: PdfFormatOption(pipeline_cls=NativePdfPipeline,
            backend=DoclingParseDocumentBackend, pipeline_options=options,
            backend_options=PdfBackendOptions(include_bitmap_images=False))})
    result = converter.convert(DocumentStream(name='source.pdf', stream=io.BytesIO(data)),
        max_num_pages=MAX_PAGES, max_file_size=MAX_BYTES, raises_on_error=False)
    if result.status != ConversionStatus.SUCCESS or result.errors or not result.document:
        raise ValueError('DOCUMENT_EXTRACTION_INCOMPLETE')
    doc = result.document
    pages = sorted(doc.pages)
    if not pages or pages != list(range(1, len(pages) + 1)) or len(pages) > MAX_PAGES:
        raise ValueError('DOCUMENT_EXTRACTION_INCOMPLETE')
    blocks, covered, total = [], set(), 0
    for item in doc.texts:
        if not item.text.strip():
            continue
        # Native text cells have one source region; never repeat text across guessed regions.
        if len(item.prov) != 1:
            raise ValueError('DOCUMENT_PROVENANCE_INVALID')
        prov = item.prov[0]
        page = doc.pages[prov.page_no]
        box = prov.bbox.to_top_left_origin(page_height=page.size.height)
        covered.add(prov.page_no)
        total += len(item.text)
        blocks.append({'page': prov.page_no, 'text': item.text,
            'bbox': {'x': box.l, 'y': box.t, 'width': box.r-box.l, 'height': box.b-box.t}})
        if total > MAX_TEXT or len(blocks) > MAX_BLOCKS:
            raise ValueError('DOCUMENT_OUTPUT_LIMIT')
    if covered != set(pages):
        raise ValueError('DOCUMENT_OCR_REQUIRED')
    return {'version': VERSION, 'sourceSha256': hashlib.sha256(data).hexdigest(),
        'pages': [{'number': n, 'width': doc.pages[n].size.width, 'height': doc.pages[n].size.height} for n in pages],
        'blocks': blocks}


if __name__ == '__main__':
    # Container additionally supplies a hard memory/CPU/pid boundary and no outbound route.
    signal.alarm(28)
    try:
        result = extract(sys.stdin.buffer.read(MAX_BYTES + 1))
        output = json.dumps(result, ensure_ascii=False, allow_nan=False).encode('utf-8')
        if len(output) > 8 * 1024 * 1024:
            raise ValueError('DOCUMENT_OUTPUT_LIMIT')
        sys.stdout.buffer.write(output)
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and str(error).startswith('DOCUMENT_') else 'DOCUMENT_EXTRACTION_FAILED'
        sys.stdout.write(json.dumps({'error': code}))
        sys.exit(1)
