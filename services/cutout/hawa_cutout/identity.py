"""What the service is, reported with every answer so a design can pin the derivation it used
(ADR-123). The matting model's sha256 was already reported; this adds the service code, the Python
and package versions that run it, and the face detector's own bytes, which decide crop focus.

Kept free of the inference dependencies so it can be checked anywhere Python runs."""
from __future__ import annotations

import hashlib
import os
import platform
from importlib import metadata

# Bumped when the service's reply contract changes; the code hash below covers every source change.
IMPLEMENTATION = 'hawa-cutout/2'
PACKAGES = ('numpy', 'onnxruntime', 'opencv-python-headless', 'pillow')


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def code_sha256(root: str | None = None) -> str:
    """The service's own Python sources, by name and bytes, in a stable order."""
    root = root or os.path.dirname(os.path.abspath(__file__))
    h = hashlib.sha256()
    for name in sorted(n for n in os.listdir(root) if n.endswith('.py')):
        with open(os.path.join(root, name), 'rb') as f:
            data = f.read()
        h.update(f'{name}\0{len(data)}\0'.encode())
        h.update(data)
    return h.hexdigest()


def _version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def runtime_identity(face_model_path: str, root: str | None = None, packages: tuple[str, ...] = PACKAGES) -> dict[str, object]:
    """Raises OSError when the face model cannot be read: an unidentified detector is not reported."""
    return {
        'implementation': IMPLEMENTATION,
        'codeSha256': code_sha256(root),
        'python': platform.python_version(),
        'packages': {name: _version(name) for name in packages},
        'faceModelSha256': _sha256_file(face_model_path),
    }
