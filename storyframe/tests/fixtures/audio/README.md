# Audio upload fixtures

One-second 440 Hz tones used by `npm run verify:narration-live` to prove that the
media path detects the M4A, OGG, and AAC containers from their bytes rather than
trusting the declared `Content-Type`. They are committed so the check runs without
an encoder, and 16 kHz mono keeps each file under 5 kB.

Regenerate them with ffmpeg. These commands reproduce the committed files; M4A and
OGG differ only in encoder metadata:

```bash
ffmpeg -f lavfi -i "sine=frequency=440:duration=1" -ac 1 -ar 16000 -c:a aac -b:a 24k -f ipod tone-1s.m4a
ffmpeg -f lavfi -i "sine=frequency=440:duration=1" -ac 1 -ar 16000 -c:a libvorbis -b:a 24k tone-1s.ogg
ffmpeg -f lavfi -i "sine=frequency=440:duration=1" -ac 1 -ar 16000 -c:a aac -b:a 24k -f adts tone-1s.aac
```

Measured durations: `tone-1s.m4a` 1.064 s, `tone-1s.ogg` 1.000 s, `tone-1s.aac` 1.088 s.
