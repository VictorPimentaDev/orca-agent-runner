"""Capture actual demo output; pace the cast/GIF for readability. Needs Pillow."""
import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[1]
result = subprocess.run(
    ['node', 'examples/demo.mjs'], cwd=root, check=True, capture_output=True, text=True
)
lines = result.stdout.splitlines()
assert lines[-2].startswith('PASS /')
assets = root / 'assets'
assets.mkdir(exist_ok=True)
header = {'version': 2, 'width': 100, 'height': 22,
          'timestamp': int(datetime.now(UTC).timestamp()),
          'title': 'Orca runner: real local fixture, playback paced for readability',
          'env': {'TERM': 'xterm-256color', 'SHELL': '/bin/sh'}}
cast = [json.dumps(header)]
for i, line in enumerate(lines):
    cast.append(json.dumps([round(.8 * i, 2), 'o', line + '\r\n']))
cast.append(json.dumps([round(.8 * len(lines) + 3, 2), 'o', '\r\n']))
(assets / 'demo.cast').write_text('\n'.join(cast) + '\n')
font_path = Path('/System/Library/Fonts/Menlo.ttc')


def font(size):
    return ImageFont.truetype(str(font_path), size) if font_path.exists() else (
        ImageFont.load_default(size=size)
    )


frames = []
for count in range(1, len(lines) + 1):
    canvas = Image.new('RGB', (1280, 720), '#0d141d')
    draw = ImageDraw.Draw(canvas)
    draw.text((40, 26), 'ORCA AGENT RUNNER', fill='#d9e6f2', font=font(24))
    draw.text((820, 30), 'LOCAL PROTOCOL / NO LLM', fill='#6ad1bb', font=font(18))
    draw.rounded_rectangle((30, 88, 1250, 650), radius=14, fill='#131e2b', outline='#304050')
    for index, line in enumerate(lines[:count]):
        color = '#6ad1bb' if line.startswith(('$', 'PASS')) else '#c6d4df'
        draw.text((52, 120 + 38 * index), line, fill=color, font=font(21))
    draw.text((40, 679), 'Actual CLI output · playback paced for readability',
              fill='#8195a8', font=font(17))
    frames.append(canvas)
frames[0].save(assets / 'demo.gif', save_all=True, append_images=frames[1:],
               duration=[800] * (len(frames) - 1) + [3500], loop=0)
frames[-1].save(assets / 'demo.png')
card = Image.new('RGB', (1280, 640), '#0d141d')
draw = ImageDraw.Draw(card)
draw.text((64, 60), 'ORCA AGENT RUNNER', fill='#6ad1bb', font=font(24))
draw.text((64, 150), 'A spec. Isolated worktrees.\nVerifiable completion.',
          fill='#e2ecf5', font=font(44), spacing=18)
for index, label in enumerate(['SPEC', 'WORKER', 'FIM', 'CLEANUP']):
    x = 64 + index * 290
    draw.rounded_rectangle((x, 350, x + 258, 427), radius=10, outline='#385465', width=2)
    draw.text((x + 28, 373), label, fill='#6ad1bb', font=font(25))
draw.text((64, 490), 'TypeScript CLI · Bring your coding agent', fill='#b9cbd8', font=font(24))
draw.text((64, 569), 'VictorPimentaDev / orca-agent-runner', fill='#8195a8', font=font(20))
card.save(assets / 'social-preview.png')
print('Captured demo.cast; rendered demo.gif, demo.png and social-preview.png.')
