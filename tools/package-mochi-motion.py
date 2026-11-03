"""Pack Mochi's authored motion candidates alongside the existing full-body atlas.

Source artwork lives in the sibling character-sources directory. Inspect the
output before shipping rebuilt packs.
"""
import importlib.util
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import binary_dilation, label

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT.parent / 'character-sources' / 'mochi-motion-v1'
CHARACTER = ROOT / 'assets/characters/mochi'
spec = importlib.util.spec_from_file_location('packer', ROOT / 'tools/pack-character.py')
packer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packer)


def clean(image):
    pixels = np.array(image.convert('RGBA'))
    labels, _ = label(pixels[:, :, 3] > 80)
    sizes = np.bincount(labels.ravel())
    assert len(sizes) > 1 and sizes[1:].max() > 10000, 'Missing figure'
    keep = binary_dilation(labels == 1 + np.argmax(sizes[1:]), iterations=2)
    pixels[:, :, 3] = np.where(keep, pixels[:, :, 3], 0)
    pixels[pixels[:, :, 3] == 0, :3] = 0
    result = Image.fromarray(pixels)
    bounds = result.getchannel('A').getbbox()
    assert bounds and bounds[0] > 0 and bounds[1] > 0 and bounds[2] < image.width and bounds[3] < image.height, 'Figure clipped'
    return result.crop(bounds)


def register(pose, height=500, bottom=834):
    assert pose.height >= height, 'Do not enlarge source artwork'
    width = round(pose.width * height / pose.height)
    assert width <= 620, 'Figure too wide for logical frame'
    pose = pose.convert('RGBa').resize((width, height), Image.Resampling.LANCZOS).convert('RGBA')
    frame = Image.new('RGBA', (640, 840))
    frame.alpha_composite(pose, ((640 - width) // 2, bottom - height))
    return frame


def build(view, motion):
    base = CHARACTER / f'sequence-30-{view}'
    out = CHARACTER / f'sequence-motion-{view}'
    manifest = json.loads((base / 'manifest.json').read_text(encoding='utf-8'))
    variant = next(v for v in manifest['variants'] if v['frameWidth'] == 640)
    layer = variant['layers'][0]
    pages = [Image.open(base / p['file']).convert('RGBA') for p in variant['pages']]
    frames = [pages[f['page']].crop((f['x'], f['y'], f['x'] + 640, f['y'] + 840)) for f in layer['frames']]
    if view == 'bust':
        # Fit the upper-body portion of the full pose to the existing bust crop.
        crop = manifest['crop']
        x, y = round(crop['x'] * 2), round(crop['y'] * 2)
        w, h = round(crop['width'] * 2), round(crop['height'] * 2)
        bust = []
        for image in motion:
            portion = image.crop((210, 341, 468, 679)).convert('RGBa').resize((w, h), Image.Resampling.LANCZOS).convert('RGBA')
            frame = Image.new('RGBA', (640, 840)); frame.alpha_composite(portion, (x, y)); bust.append(frame)
        frames.extend(bust)
    else:
        frames.extend(motion)
    tracks = dict(layer['tracks'])
    tracks.update(walk=list(range(30, 34)), sit=[34, 34, 35, 34, 36, 34, 37, 34], held=[38], dance=[39, 40, 41, 42])
    result = packer.pack({'sourceDetail': 'Existing Mochi frames with authored motion candidates'},
                         [({'id': 'body', 'role': 'composite', 'continuousTracks': True, 'tracks': tracks}, frames)],
                         out, (320, 640), 2048)
    result['crop'] = manifest['crop']
    (out / 'manifest.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print('Motion pack:', out)


if __name__ == '__main__':
    sheet = Image.open(SOURCE / 'walk-right-cycle.png').convert('RGBA')
    motion = []
    for i in range(4):
        left, right = round(i * sheet.width / 4), round((i + 1) * sheet.width / 4)
        motion.append(register(clean(sheet.crop((left, 0, right, sheet.height))).transpose(Image.Transpose.FLIP_LEFT_RIGHT)))
    sheet = Image.open(SOURCE / 'sit-cycle.png').convert('RGBA')
    for i in range(4):
        left, right = round(i * sheet.width / 4), round((i + 1) * sheet.width / 4)
        motion.append(register(clean(sheet.crop((left, 0, right, sheet.height))), height=440, bottom=764))
    motion.append(register(clean(Image.open(SOURCE / 'held-full.png'))))
    sheet = Image.open(SOURCE / 'dance-cycle.png').convert('RGBA')
    for i in range(4):
        left, right = round(i * sheet.width / 4), round((i + 1) * sheet.width / 4)
        motion.append(register(clean(sheet.crop((left, 0, right, sheet.height)))))
    for view in ('full', 'bust'):
        build(view, motion)
