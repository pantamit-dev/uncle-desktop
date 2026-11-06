# Character sprite pipeline

All placement, pivot and hit-test coordinates use the original 320x420 logical space. The v2 manifest can reference pages at 320x420, 640x840 or 960x1260 per frame. The renderer selects a tier using display scale, crop and device-pixel ratio, bounded by the detected WebGL maximum texture dimension and a 32 MiB working-set cap. A shared 64 MiB LRU cache decodes pages serially and releases evicted ImageBitmaps. If the manifest cannot be loaded, the catalog's original `atlas` is used.

Active packs in catalog.json (source 0.23.10, checked 2026-11-01):

| Character | Full-body manifest frames | Dedicated bust manifest frames | Available frame-size tiers |
|---|---|---|---|
| Mochi | 55 | 55 | 320x420, 640x840 |
| Lili | 31 | 31 | 320x420, 640x840 |
| Luna, Pudding, Tama | 12 each | 12 each | 320x420, 640x840 |
| Peegee | 12 | none; renderer crops full-body art | 320x420, 640x840 |

These counts describe the active whole-image layer in each manifest, not every older pack left in the asset directory. They do not imply independent eyes, mouth or hands. Audio switches between authored whole-frame poses; it is not phoneme lip sync. Storage dimensions do not imply that every figure fills its canvas or has native detail at that entire size. No current 960x1260 native-detail artwork is claimed. Small outfit differences may appear when switching poses.

To create new native-resolution packs, provide registered RGBA PNG images on equal 320:420 canvases, with transparent backgrounds and complete joints. A manifest JSON source example:

```json
{
  "rigged": true,
  "layers": [
    {"id":"torso", "role":"torso", "pivot":[160,270], "files":["torso.png"], "tracks":{"idle":[0]}},
    {"id":"head", "parent":"torso", "role":"head", "pivot":[160,130], "files":["head.png"], "tracks":{"idle":[0]}},
    {"id":"eyes", "parent":"head", "role":"eyes", "files":["eyes-open.png","eyes-closed.png"], "tracks":{"open":[0],"blink":[1],"closed":[1]}}
  ]
}
```

The packer supports `leg`, `torso`, `head`, `eyes`, `pupil`, `brow`, `mouth` and other named layers. Authored `pivot`, `foot`, `side`, frame `anchors`, `tracks`, optional safe `clip` rectangles and spring parameters may be supplied per layer. Physics is a bounded rigid-layer spring, not collision detection or anatomical soft-body simulation. Independent skeletal movement requires separated, registered pieces with covered joints. Generated part sheets in `../character-sources/layered-0.19` are unregistered concepts; they are not connected to the current characters. Configured whole-image characters instead use a bounded local torso texture warp.

Install Pillow, NumPy and SciPy in the local Python environment for the asset scripts. For source frames at least 960x1260:

```sh
python tools/pack-character.py path/to/spec.json --out assets/characters/example/sprites --resolutions 320,640,960 --max-texture 2048
npm test
npm run dist
```

The packer rejects requests for resolution greater than the source canvas; it does not reconstruct detail. For existing 4x6 files, `--legacy path/to/atlas.webp` creates a 320 tier. `tools/package-bust-sheets.py` extracts the six authored poses from a 1536x1024 imagegen sheet and pads them without upscaling. Tests: `node --test tests/character-pipeline.test.js` and, with the app running `--dev`, `node scripts/smoke-layered-display.js`.

Mochi's newer `sequence-30-full` and `sequence-30-bust` packs contain 24 state frames plus six ordered conversation frames per view, generated in separate small sheets. `continuousTracks` opts into the authored idle sequence instead of the older director's idle hold. `orderedSpeech` selects adjacent small or full gestures, with a 110ms crossfade that settles before the next speech frame. Other characters retain their existing director. `tools/package-mochi-30.py --activate` rebuilds both views and the 24-frame legacy fallback; source prompts and measured torso calibration are in `../character-sources/mochi-30`. The local torso warp now supplies bounded secondary movement for configured characters; it is a texture deformation, not anatomical soft-body simulation.

Mochi's active `sequence-motion` packs preserve those 30 frames and add side-profile walking, seated, held, dancing, waking and arrival frames; the departure track reverses the arrival frames. The left-facing walk art is mirrored for rightward walking; asymmetric clothing changes sides when mirrored. New bust action frames are cropped and enlarged from the full-body action art, so they do not have the same native detail as the original dedicated bust frames. `tools/package-mochi-motion.py` rebuilds these packs using source art in `../character-sources/mochi-motion-v1`. Seated dance currently uses seated frames with procedural movement, and the original entrance/exit effects remain active.

Lili's `action-v1` packs retain the existing 12 frames and add four side-profile walking frames, four seated frames, three waking frames, four seated greeting frames and four standing greeting frames. Departure tracks reverse the greeting frames, and the walking art is mirrored for the other direction. New bust action frames are cropped and enlarged from full-body art. Held uses the existing fallback and dance uses procedural movement. Rebuild with `tools/package-lili-motion.py` using the local source images in `../character-sources/lili-motion-v1`.

In 0.23.1, Mochi randomly chooses among three coherent ambient paths and three speech paths, excluding the last-used path and varying dwell times. `idleMotion` and `thinkingMotion` map the ambient indices to authored frames. Speech and important states take priority. Mochi's torso uses a calibrated impulse of 45 (previously 32) and visual gain 1.6; the existing gradient/foldover clamps still apply.

The Behavior > Mini player and dancing to music setting enables dancing while the OS reports an active playing media session. Pause/stop clears it. Speech, work, alerts, sleep, dragging and reduced motion suppress dancing. This uses media metadata, not microphone capture or audio beat detection; players that do not publish a system media session cannot trigger automatic dancing. Companion dance/stop_dance commands can enable or suppress dancing, but cannot start it without a playing session. Idle activities are selected with equal probability among the actions available in the current stance; reactions and direct user actions are event-driven.
