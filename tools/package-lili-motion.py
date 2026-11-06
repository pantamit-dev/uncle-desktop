"""Build Lili action atlas candidates from artwork in ../character-sources."""
import importlib.util
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT.parent / 'character-sources/lili-motion-v1'
CHARACTER = ROOT / 'assets/characters/lili'
spec = importlib.util.spec_from_file_location('mochi_packer', ROOT / 'tools/package-mochi-motion.py')
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)


def extract(filename, *, mirror=False, height=600, indices=range(4)):
    sheet = Image.open(SOURCE / filename).convert('RGBA')
    frames = []
    for i in indices:
        left, right = round(i * sheet.width / 4), round((i + 1) * sheet.width / 4)
        pose = common.clean(sheet.crop((left, 0, right, sheet.height)))
        if mirror:
            pose = pose.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        frames.append(common.register(pose, height=height))
    return frames


def build(view, actions):
    base = CHARACTER / f'motion-{view}'
    out = CHARACTER / f'action-v1-{view}'
    manifest = json.loads((base / 'manifest.json').read_text(encoding='utf-8'))
    variant = next(v for v in manifest['variants'] if v['frameWidth'] == 640)
    layer = variant['layers'][0]
    pages = [Image.open(base / p['file']).convert('RGBA') for p in variant['pages']]
    frames = [pages[f['page']].crop((f['x'], f['y'], f['x'] + 640, f['y'] + 840)) for f in layer['frames']]
    tracks = dict(layer['tracks'])
    for name, source in actions.items():
        start = len(frames)
        for image in source:
            if view == 'bust':
                crop = manifest['crop']
                x, y = round(crop['x'] * 2), round(crop['y'] * 2)
                w, h = round(crop['width'] * 2), round(crop['height'] * 2)
                portion = image.crop((154, 200, 484, 632)).convert('RGBa').resize((w, h), Image.Resampling.LANCZOS).convert('RGBA')
                image = Image.new('RGBA', (640, 840)); image.alpha_composite(portion, (x, y))
            frames.append(image)
        tracks[name] = list(range(start, len(frames)))
    if 'perch_arrive' in tracks:
        tracks['perch_leave'] = list(reversed(tracks['perch_arrive']))
    if 'arrive' in tracks:
        tracks['leave'] = list(reversed(tracks['arrive']))
    result = common.packer.pack({'sourceDetail': 'Existing Lili frames and experimental action frames'},
        [({'id': 'body', 'role': 'composite', 'tracks': tracks}, frames)], out, (320, 640), 2048)
    result['crop'] = manifest['crop']
    (out / 'manifest.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print('Motion pack:', out)


if __name__ == '__main__':
    actions = {'walk': extract('walk-transparent-candidate.png', mirror=True, height=640),
               'sit': extract('sit-transparent-candidate.png'),
               'wake': extract('wake-source-candidate.png', height=640, indices=(0, 1, 3)),
               'perch_arrive': extract('perch-arrive-candidate.png'),
               'arrive': extract('arrive-candidate.png', height=640)}
    for view in ('full', 'bust'):
        build(view, actions)
