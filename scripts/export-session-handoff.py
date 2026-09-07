#!/usr/bin/env python3
"""Export recorded visible conversation/actions for one Codex thread tree, locally.

No model requests, source-log mutation, command replay, or network access.
Private reasoning and system/developer instructions are not exported.
"""
import argparse
import collections
import datetime
import hashlib
import json
import os
from pathlib import Path
import sqlite3


def public(value):
    if isinstance(value, list):
        return [clean for item in value if (clean := public(item)) is not None]
    if not isinstance(value, dict):
        return value
    if value.get('type') in ('reasoning', 'Reasoning', 'encrypted_content') or value.get('role') in ('system', 'developer'):
        return None
    return {key: public(item) for key, item in value.items()
            if key not in ('encrypted_content', 'internal_chat_message_metadata_passthrough', 'raw_content', 'base_instructions')}


def selected(row):
    kind, payload = row.get('type'), row.get('payload', {})
    if kind == 'response_item':
        return payload.get('type') in ('message', 'agent_message', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output') and payload.get('role') not in ('system', 'developer')
    if kind == 'event_msg':
        return payload.get('type') in ('task_started', 'task_complete', 'turn_aborted', 'thread_goal_updated') or (payload.get('type') == 'item_completed' and payload.get('item', {}).get('type') != 'Reasoning')
    return kind in ('realtime_item', 'inter_agent_communication_metadata')


def text_parts(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return '\n'.join(item.get('text', '') for item in content if isinstance(item, dict) and isinstance(item.get('text'), str))
    return json.dumps(content, ensure_ascii=False)


def export(args):
    destination = Path(args.output).resolve()
    marker = destination / '.session-export'
    if destination.exists() and not marker.exists():
        raise SystemExit('Refusing an existing destination without the exporter marker')
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    marker.write_text(args.thread + '\n') if not marker.exists() else None
    if marker.read_text().strip() != args.thread:
        raise SystemExit('Destination belongs to a different thread')
    database = Path(args.codex_dir) / 'state_5.sqlite'
    connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    ids = [args.thread]
    for parent in ids:
        for row in connection.execute('SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id=?', (parent,)):
            if row[0] not in ids:
                ids.append(row[0])
    inventory, chronology = [], []
    for thread in ids:
        dbrow = connection.execute('SELECT id,rollout_path,agent_path,agent_nickname,title,cwd FROM threads WHERE id=?', (thread,)).fetchone()
        if dbrow is None:
            inventory.append({'id': thread, 'missing': 'thread metadata'})
            continue
        info = dict(dbrow)
        source = Path(info['rollout_path'])
        if not source.exists():
            info['missing'] = 'rollout file'
            inventory.append(info)
            continue
        folder = destination / thread
        folder.mkdir(exist_ok=True, mode=0o700)
        digest, total, kept = hashlib.sha256(), collections.Counter(), collections.Counter()
        unmatched, matched, offset, ordinal, malformed = {}, set(), 0, 0, []
        cutoff = source.stat().st_size
        final_timestamp = None
        with source.open('rb') as stream, (folder / 'events.jsonl').open('w') as events, (folder / 'conversation.md').open('w') as transcript:
            transcript.write(f'# Recorded conversation: {info["agent_path"] or "root"}\n\nThread: {thread}\n\nMessages retain source order. User-role context blocks may be automatic context, not user requests. Tool inputs/results are in events.jsonl; source ordinal and byte offset identify the original record.\n\n')
            while offset < cutoff:
                raw = stream.readline(cutoff - offset)
                if not raw:
                    break
                digest.update(raw)
                start = offset
                offset += len(raw)
                ordinal += 1
                try:
                    row = json.loads(raw)
                except (ValueError, UnicodeDecodeError):
                    malformed.append({'ordinal': ordinal, 'offset': start, 'bytes': len(raw)})
                    continue
                payload = row.get('payload', {})
                typ = payload.get('type', row.get('type'))
                total[str(row.get('type')) + '/' + str(typ)] += 1
                if not selected(row):
                    continue
                clean = public(row)
                if clean is None or clean.get('payload') is None:
                    continue
                final_timestamp = row.get('timestamp', final_timestamp)
                record = {'source_ordinal': ordinal, 'source_byte_offset': start, **clean}
                events.write(json.dumps(record, ensure_ascii=False) + '\n')
                kept[str(row.get('type')) + '/' + str(typ)] += 1
                call = payload.get('call_id')
                if typ in ('function_call', 'custom_tool_call'):
                    unmatched[call] = {'ordinal': ordinal, 'name': payload.get('name')}
                if typ in ('function_call_output', 'custom_tool_call_output'):
                    matched.add(call)
                if row.get('type') == 'response_item' and typ in ('message', 'agent_message'):
                    speaker = payload.get('role') or payload.get('author') or 'agent'
                    body = text_parts(public(payload.get('content', [])))
                    transcript.write(f'## {row.get("timestamp", "unknown time")} — {speaker} — source record {ordinal}\n\n{body}\n\n')
                if row.get('type') == 'event_msg' and typ == 'item_completed':
                    item = clean['payload'].get('item', {})
                    if item.get('type') not in ('UserMessage', 'AgentMessage', 'ContextCompaction'):
                        chronology.append({'timestamp': row.get('timestamp'), 'thread': thread, 'agent': info['agent_path'] or 'root', 'source_ordinal': ordinal, 'event_file': str(Path(thread) / 'events.jsonl'), 'type': item.get('type'), 'id': item.get('id'), 'command': item.get('command'), 'cwd': item.get('cwd'), 'tool': item.get('tool'), 'status': item.get('status'), 'exit_code': item.get('exit_code')})
        info.update(source_bytes_at_start=cutoff, captured_bytes=offset, captured_prefix_sha256=digest.hexdigest(), source_records=ordinal, last_exported_timestamp=final_timestamp, exported_records=sum(kept.values()), source_types=dict(total), exported_types=dict(kept), malformed_records=malformed, calls_without_recorded_output=[dict(call_id=key, **value) for key, value in unmatched.items() if key not in matched])
        inventory.append(info)
    connection.close()
    chronology.sort(key=lambda x: (x['timestamp'] or '', x['thread'], x['source_ordinal']))
    with (destination / 'action-index.jsonl').open('w') as target:
        for record in chronology:
            target.write(json.dumps(record, ensure_ascii=False) + '\n')
    manifest = {'exported_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'root_thread': args.thread, 'threads': inventory, 'action_index_entries': len(chronology), 'scope': 'Recorded user/assistant messages, tool calls/results, visible execution/file-change/tool events, inter-agent messages and turn lifecycle, through each captured byte cutoff.', 'omissions': ['Private reasoning, encrypted content and system/developer instructions.', 'Duplicate token-accounting records, internal context snapshots and compacted private context.', 'Outputs already truncated or absent in the source are not reconstructed.', 'External file/image references remain references unless included separately in the handoff package.', 'The currently running export call cannot contain its own future result or the final response; rerun after session completion to refresh.'], 'duplication': 'Response-item calls and completed UI action records intentionally coexist. Use call IDs/item IDs; do not count them as separate executions.'}
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
    hashes = {}
    for path in sorted(destination.rglob('*')):
        if path.is_file() and path.name != 'SHA256SUMS.json':
            with path.open('rb') as stream:
                hashes[str(path.relative_to(destination))] = hashlib.file_digest(stream, 'sha256').hexdigest()
    (destination / 'SHA256SUMS.json').write_text(json.dumps(hashes, indent=2) + '\n')
    print(json.dumps({'output': str(destination), 'threads': len(inventory), 'records': sum(x.get('exported_records', 0) for x in inventory), 'actions': len(chronology), 'missing_threads': [x['id'] for x in inventory if 'missing' in x], 'malformed_records': sum(len(x.get('malformed_records', [])) for x in inventory), 'cutoff': manifest['exported_at_utc']}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--thread', default=os.environ.get('CODEX_THREAD_ID'))
    parser.add_argument('--codex-dir', default=str(Path.home() / '.codex'))
    parser.add_argument('--output')
    parser.add_argument('--self-test', action='store_true')
    options = parser.parse_args()
    if options.self_test:
        assert public({'type': 'Reasoning', 'raw_content': 'private'}) is None
        assert public({'role': 'developer', 'content': 'private'}) is None
        assert public({'type': 'agent_message', 'content': [{'type': 'input_text', 'text': 'keep'}, {'type': 'encrypted_content', 'encrypted_content': 'omit'}]})['content'] == [{'type': 'input_text', 'text': 'keep'}]
        assert selected({'type': 'response_item', 'payload': {'type': 'function_call_output', 'output': 'failed'}})
        assert not selected({'type': 'event_msg', 'payload': {'type': 'item_completed', 'item': {'type': 'Reasoning'}}})
        print('Exporter self-check passed')
    else:
        if not options.thread or not options.output:
            parser.error('--thread and --output are required')
        export(options)
