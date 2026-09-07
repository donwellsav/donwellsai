"""Read-only comparison of an AgentsView SQLite archive and its native DuckDB mirror."""
import argparse
import hashlib
import json
import math
import sqlite3
import statistics
from pathlib import Path
from time import perf_counter
import duckdb

p = argparse.ArgumentParser()
p.add_argument('--sqlite', type=Path, required=True)
p.add_argument('--duckdb', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
args = p.parse_args()
assert not args.output.exists()
paths = {'sqlite': args.sqlite.resolve(), 'duckdb': args.duckdb.resolve()}
digest = lambda path: hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()
before = {name: digest(path) for name, path in paths.items()}
queries = {
    'sessionsByDay': "SELECT substr(CAST(started_at AS VARCHAR),1,10) AS day_bucket,agent,count(*) sessions,sum(CASE WHEN has_total_output_tokens=1 THEN total_output_tokens END) output_tokens,sum(CASE WHEN has_total_output_tokens=1 THEN 1 ELSE 0 END) covered_sessions FROM sessions WHERE deleted_at IS NULL GROUP BY 1,2 ORDER BY 1,2",
    'tokensByModel': "SELECT model,count(*) measured_messages,sum(CAST(json_extract(token_usage,'$.input_tokens') AS BIGINT)) input_tokens,sum(CAST(json_extract(token_usage,'$.output_tokens') AS BIGINT)) output_tokens,sum(CAST(json_extract(token_usage,'$.cache_read_input_tokens') AS BIGINT)) cache_read_tokens FROM messages WHERE token_usage IS NOT NULL AND token_usage!='' GROUP BY model ORDER BY model",
    'costCoverage': "SELECT cost_status,count(*) events,sum(cost_microdollars) reported_microdollars FROM usage_events GROUP BY cost_status ORDER BY cost_status",
    'outcomeSignals': "SELECT agent,outcome,count(*) sessions,sum(tool_failure_signal_count) tool_failure_signals FROM sessions WHERE deleted_at IS NULL GROUP BY agent,outcome ORDER BY agent,outcome",
    'contextPressure': "SELECT agent,max(CASE WHEN has_peak_context_tokens=1 THEN peak_context_tokens END) peak_context_tokens,sum(CASE WHEN has_peak_context_tokens=1 THEN 1 ELSE 0 END) covered_sessions,count(*) sessions FROM sessions WHERE deleted_at IS NULL GROUP BY agent ORDER BY agent"
}
report = {'method': '101 alternating read-only executions on identical native archive/mirror records; first call separate, remaining 100 warm. No duplicated/synthetic scale rows.', 'engines': {}, 'limits': ['Native sessions include bounded agent-acceptance workloads and project research sessions.', 'Outcome signals are native parser heuristics, not verified test results.', 'No billed cost is inferred from tokens when usage_events has no cost records.', 'Context tokens are not CPU or RAM measurements; this archive has no process resource samples.']}
connections = {'sqlite': sqlite3.connect(paths['sqlite'].as_uri() + '?mode=ro', uri=True), 'duckdb': duckdb.connect(str(paths['duckdb']), read_only=True)}
try:
    assert connections['sqlite'].execute('select count(*) from sessions where source_missing_at is not null').fetchone()[0] == 0, 'Native mirror omits source_missing_at; compare only snapshots without missing sources'
    report['nativeMirrorOmissions'] = ['source_missing_at is not mirrored; source availability still requires SQLite/native source verification']
    for name, conn in connections.items():
        report['engines'][name] = {'version': sqlite3.sqlite_version if name == 'sqlite' else duckdb.__version__, 'bytes': paths[name].stat().st_size, 'sha256': before[name], 'sessions': conn.execute('select count(*) from sessions').fetchone()[0], 'messages': conn.execute('select count(*) from messages').fetchone()[0], 'queries': {}}
    for key, sql in queries.items():
        times = {name: [] for name in connections}
        results = {}
        for i in range(101):
            for name in (list(connections) if i % 2 == 0 else list(reversed(connections))):
                start = perf_counter(); rows = sorted(connections[name].execute(sql).fetchall(), key=lambda row: json.dumps(row, default=str)); times[name].append((perf_counter() - start) * 1000)
                assert name not in results or rows == results[name], 'Archive changed during comparison'
                results[name] = rows
        assert results['sqlite'] == results['duckdb'], f'{key}: native mirrors disagree'
        for name, samples in times.items():
            warm = sorted(samples[1:])
            report['engines'][name]['queries'][key] = {'coldMs': samples[0], 'warmMedianMs': statistics.median(warm), 'warmP95Ms': warm[math.ceil(len(warm) * .95) - 1], 'rows': results[name]}
    report['equalResults'] = True
finally:
    for conn in connections.values(): conn.close()
report['sourceHashesUnchanged'] = all(digest(path) == before[name] for name, path in paths.items())
assert report['sourceHashesUnchanged']
args.output.write_text(json.dumps(report, indent=2) + '\n')
