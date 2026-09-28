# ADR-123 — Pin the renderer and cut-out runtime; map reserved regions to the provider frame

Date: 2026-09-28. Status: implementation; locally qualified on macOS with a Debian renderer check.
Requirements: FR-074, NFR-014, FR-060, FR-026, FR-031, NFR-024. Normative sources:
MASTER_SPEC.md, docs/14_SECURITY_THREAT_MODEL.md, docs/10_WORKFLOW_RELIABILITY.md,
docs/07_MODEL_REGISTRY_AND_EVALUATION.md, docs/05_CREATIVE_ENGINE.md via plans/traceability.csv.

## Evidence

ADR-116/118 retain the fonts and the Pango measurement helper. The SVG is drawn by
rsvg-convert, whose version and linked Cairo/Pango/HarfBuzz/Fontconfig decide the pixels as
well, and by the operating-system release those libraries come from. None of these was retained:
a rasteriser upgrade between stages could change a pinned run's pixels without a hold. The
cut-out service reported the matting model hash, but not its own code, package versions or the
face detector, which also chooses each framed photo's crop focus.

The art stage described the region reserved for text in layout pixels ("centered around
(0, 945) measuring 1080x405", actually its top-left) and told the model "Aspect 9:16" for a
portrait box. The provider request was 1024x1024 by default. The renderer then covers the art
box with that image and crops the overflow evenly. The words named an area of a different frame
from the one the text finally sits over, and nothing retained or checked where it landed.

## Decision

Renderer identity. `rendererRuntimeIdentity` hashes the rsvg-convert executable the Studio
renderer resolves, records its `--version` answer and the operating-system release files
(macOS SystemVersion.plist and kernel; Linux os-release and debian_version). The install path is
not identity. The executable is hashed on every call; the version answer is remembered only per
executable hash. The retained font basis becomes version 2 and includes this identity, or
`{unavailable: true}` when no rasteriser can be identified. Visual bundles become version 3.
Recovery holds before the next model/render stage when this basis changed, exactly as for fonts.
ADR-122 substep bindings that name the renderer use the same basis, so their retained results
hold too. Version-2 bundles carry no renderer attestation and are held for review, as version 1
was; current hashes cannot vouch for the renderer that drew them.

Cut-out runtime. The service (`hawa-cutout/2`) reports `runtime` with /health, /v1/cutout and
/v1/faces: implementation, a hash of its own sources, Python and package versions, and the face
detector's sha256, read at load. A missing face model now fails the load rather than the first
request. Core retains it in the stored report. Each pinned derivation records the cut-out bytes
it produced, the runtime hash and the face-model hash; each pinned focus point records its
source photo and runtime. Legacy rows and hawa-cutout/1 answers keep those facts absent.
Capture and recovery refuse a derivation whose source photo or cut-out bytes disagree with the
pinned bytes. A pinned run never asks the service again. A changed or unavailable live service
therefore does not hold it: the pinned, hash-verified pixels are its input, and holding on the
live service would stop runs the service cannot affect.

Region mapping. The art stage reads the image settings once and passes them to the provider
call. `planArtRegion` maps the calm region through the renderer's cover crop into the requested
frame and describes it as shares of that frame ("from 10% to 90% across and 70% to 100% down
the image"), with the frame's own aspect. OpenAI `auto` sizes use the art box as an assumed
frame. The plan and a check of the returned image (`landed_as_prompted`, `frame_mismatch`,
`unreadable`, or `not_prompted` for a procedural motif) are retained in the art provenance.
Final QA recomputes the landing for the final layout against that plan (`moved` when a later
layout put the calm region elsewhere) with luminance spread in the landed region, and records
each framed photo's declared focus with the crop the renderer applies. A photo whose pixel size
cannot be read is drawn as the centred slice, and its declared focus is recorded as not applied.
The renderer returns the same placements for the bytes it drew. These are retained QA evidence,
not a new gate: legibility over the actual pixels remains the contrast gate's decision.

## Acceptance

Tests first against the previous source. Real temporary executables and release files: same-path
executable replacement changes and restoring returns the identity; a failing or absent rasteriser
is refused and recorded as unavailable; release-file changes alter the identity; the retained
basis follows the renderer. The actual rsvg-convert matches its identity. Real rasteriser pixels
show the calm region where the mapping says it lands (macOS librsvg 2.62.3 and Debian 2.54.7).
Real isolated PostgreSQL: changed renderer holds before the next stage with no transport and the
bundle unchanged, and the restored renderer resumes; the cut-out and face runtime is pinned with
each derivation and never re-requested; version-2 bundles and mismatched derivations hold.
Art-stage prompts, frames and retained checks; final QA landing, movement and unapplied focus.

## Limits

Version strings and executable hashes are not every shared-library byte: a same-version rebuild
of Cairo, Pango or librsvg, or the gdk-pixbuf WebP loader, is not seen. Debian's rsvg-convert
2.54.7 reports only its own version; its libraries are named by the Pango helper's identity when
the helper is present. No live cut-out service ran: its runtime reply is exercised in Python unit
tests and through a synthetic HTTP boundary. The deployed hawa-cutout:1 image reports no runtime
until it is rebuilt. Region checks are evidence, not calibrated thresholds; whether a better
prompt frame improves art is a paid, human-judged question not answered here. The prompt change
alters art request digests, so an in-flight run's retained art holds rather than replays.
Deploying holds every active run past layout with a version-2 bundle and every retained result
bound to the previous renderer basis: inventory them first. No paid call, native Canva operation,
deployment, process-kill drill or human study. Evidence:
`plans/lean-design-implementation-2026-09-28/RUNTIME_REGION_PROOF.json`.
