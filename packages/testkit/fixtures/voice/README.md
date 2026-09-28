# Synthetic voice container fixture

`silence-one-second.ogg` is one second of synthetic silence, generated locally with:

```sh
ffmpeg -f lavfi -i anullsrc=r=48000:cl=mono -t 1 -c:a libopus -b:a 16k -map_metadata -1 silence-one-second.ogg
```

It contains no recorded person, private source or transcription-quality evidence.
The committed bytes let tests verify real Ogg checksums, headers, packet timing,
pre-skip and end trimming without an FFmpeg dependency at runtime. FFprobe reports
Opus/mono and container duration 1.0065 seconds; audible duration after the 312
pre-skip samples is exactly one second. The packet duration reservation includes
51 encoded 20 ms packets (1.02 seconds). Fault-test transcripts are explicit mocks.
