# Synthetic media fixtures (ADR-145)

What a requester's phone sends, made locally so the conversion path is tested on real containers:

- `tone-one-second.m4a`, `tone-one-second.mp3`, `tone-one-second.wav`: one second of a 440 Hz tone,
  mono, made with
  `ffmpeg -f lavfi -i "sine=frequency=440:duration=1" -ac 1 -ar 16000 -c:a aac -b:a 24k tone-one-second.m4a`
  (and `-c:a libmp3lame -b:a 24k` for the MP3, `-ar 8000 -c:a pcm_s16le` for the WAV).
- `photo-96x64.heic`: a 96x64 test pattern (`ffmpeg -f lavfi -i testsrc=size=96x64:rate=1 -frames:v 1 src.jpg`)
  saved as HEIC with macOS `sips -s format heic src.jpg --out photo-96x64.heic` (major brand `heic`).

None contains a recorded person, a real photo or any private source. Core converts the recordings to
Ogg Opus with ffmpeg and the HEIC to JPEG with heif-convert (`apps/core/src/services/media-conversion.ts`);
`apps/core/test/media-conversion.test.ts` and the ADR-145 image proof run them.
