#!/usr/bin/env python3
"""Run a live multimodal Claude Opus 5 critique of an exported design PNG.

Usage:
    ANTHROPIC_API_KEY=... python3 scripts/test_opus5_critique.py <png path> [output json path]

The API key comes only from the environment (never from a parsed .env file), the image path
is an explicit argument (no machine-specific default), and the receipt written next to the
critique carries the response id, model and token usage so the evidence is verifiable.
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request

MODEL = 'claude-opus-5'


def run(img_path: str, out_path: str) -> int:
    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if not api_key:
        print('ERROR: ANTHROPIC_API_KEY must be set in the environment', file=sys.stderr)
        return 2
    if not os.path.isfile(img_path):
        print(f'ERROR: image {img_path} does not exist', file=sys.stderr)
        return 2
    with open(img_path, 'rb') as f:
        img_bytes = f.read()
    payload = {
        'model': MODEL,
        'max_tokens': 4000,
        'messages': [{
            'role': 'user',
            'content': [
                {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png', 'data': base64.b64encode(img_bytes).decode('ascii')}},
                {'type': 'text', 'text': (
                    'You are an elite Senior Art Director evaluating a VIP formal invitation designed for KAAE '
                    '(Kurdistan Accrediting Association for Education). Evaluate the visual design on: '
                    '1. Copy accuracy and typography hierarchy; 2. Layout balance, margins and whitespace; '
                    '3. Visual elegance and brand fidelity (cream cardstock, gold rules, navy typography, official KAAE crest); '
                    '4. Text collisions or legibility issues; 5. Overall production readiness. '
                    'Return strictly JSON: {"score": <1-10>, "passed": <bool>, "summary": <string>, '
                    '"issues": [<string>], "recommendations": [<string>]}.'
                )},
            ],
        }],
    }
    req = urllib.request.Request(
        'https://api.anthropic.com/v1/messages', data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'x-api-key': api_key, 'anthropic-version': '2023-06-01'},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as res:
            body = json.loads(res.read().decode('utf-8'))
    except urllib.error.HTTPError as err:
        print(f'ERROR: Anthropic API HTTP {err.code}: {err.read().decode("utf-8", "replace")[:500]}', file=sys.stderr)
        return 1
    text = ''.join(block.get('text', '') for block in body.get('content', []) if block.get('type') == 'text')
    try:
        critique = json.loads(text[text.index('{'):text.rindex('}') + 1])
    except (ValueError, json.JSONDecodeError):
        critique = {'raw': text}
    receipt = {
        'provider': 'anthropic', 'requestedModel': MODEL, 'returnedModel': body.get('model'), 'responseId': body.get('id'),
        'stopReason': body.get('stop_reason'), 'usage': body.get('usage'), 'imageBytes': len(img_bytes), 'imagePath': os.path.abspath(img_path),
    }
    if body.get('model') != MODEL:
        print(f'ERROR: receipt returned model {body.get("model")!r}, expected {MODEL!r}', file=sys.stderr)
        return 1
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump({'critique': critique, 'receipt': receipt}, f, indent=2, ensure_ascii=False)
    print(json.dumps({'score': critique.get('score'), 'passed': critique.get('passed'), 'responseId': receipt['responseId']}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(run(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else 'opus5_critique.json'))
