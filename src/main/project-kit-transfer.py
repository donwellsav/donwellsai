"""Decode bounded native Hindsight document-transfer entries; never extract files."""
import base64
import io
import json
import re
import sys
import zipfile
value = json.load(sys.stdin)
if 'documents' in value:
    documents = value['documents']
    if not isinstance(documents, list) or len(documents) > 50:
        raise ValueError('Transfer document limit exceeded')
    if len(json.dumps(documents).encode()) > 16 * 1024 * 1024:
        raise ValueError('Transfer documents exceed 16 MiB')
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('manifest.json', json.dumps({'schema_version': 1, 'archive_type': 'documents', 'source_bank_id': 'donwells-portable', 'document_count': len(documents), 'fact_count': sum(len(document['facts']) for document in documents)}))
        for index, document in enumerate(documents):
            archive.writestr(f'documents/{index:06d}.json', json.dumps(document))
    if len(output.getvalue()) > 8 * 1024 * 1024:
        raise ValueError('Transfer archive exceeds 8 MiB')
    print(json.dumps({'archiveBase64': base64.b64encode(output.getvalue()).decode()}))
    sys.exit(0)
archive = base64.b64decode(value['archiveBase64'], validate=True)
if len(archive) > 8 * 1024 * 1024:
    raise ValueError('Transfer archive exceeds 8 MiB')
with zipfile.ZipFile(io.BytesIO(archive)) as source:
    entries = source.infolist()
    if len(entries) > 51 or len({entry.filename for entry in entries}) != len(entries) or sum(entry.file_size for entry in entries) > 16 * 1024 * 1024:
        raise ValueError('Transfer archive bounds exceeded')
    if any(not (entry.filename == 'manifest.json' or re.fullmatch(r'documents/\d{6}\.json', entry.filename)) for entry in entries):
        raise ValueError('Only document transfers are supported; bank configuration and observation archives require separate review')
    manifest = json.loads(source.read('manifest.json'))
    documents = [json.loads(source.read(entry)) for entry in entries if entry.filename.startswith('documents/')]
    if manifest.get('schema_version') != 1 or manifest.get('archive_type', 'documents') != 'documents' or manifest.get('document_count') != len(documents):
        raise ValueError('Invalid document-transfer manifest')
    print(json.dumps({'manifest': manifest, 'documents': documents}))
