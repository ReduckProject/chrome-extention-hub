import hashlib
import json
from pathlib import Path
from PIL import Image

project = Path(__file__).resolve().parent.parent
state = json.loads((project / 'runtime/state.json').read_text(encoding='utf-8'))
evidence = json.loads((project / 'artifacts/live-acceptance.json').read_text(encoding='utf-8'))
records = []
for request in evidence['requests']:
    run = next(run for run in state['runs'].values() if run['requestId'] == request['requestId'])
    assert run['phase'] == 'completed'
    for file in run['verifiedDownloads']:
        image_path = Path(file['path'])
        digest = hashlib.sha256(image_path.read_bytes()).hexdigest()
        assert digest == file['sha256']
        with Image.open(image_path) as img:
            img.load()
            assert img.size == (file['width'], file['height'])
            assert img.format == 'PNG'
            records.append({'runId': run['id'], 'conversationUrl': 'https://chatgpt.com/c/' + run['conversationId'], 'prompt': run['prompt'], 'path': str(image_path), 'sha256': digest, 'width': img.width, 'height': img.height, 'format': img.format, 'mode': img.mode, 'fullyDecoded': True})
assert len(records) == 3
(project / 'artifacts/image-verification.json').write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(records, ensure_ascii=False, indent=2))
