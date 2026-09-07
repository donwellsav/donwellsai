import json
import sys
import duckdb

if duckdb.__version__ != '1.5.5':
    raise RuntimeError('Analytics requires admitted DuckDB 1.5.5')
connection = duckdb.connect(':memory:', config={
    'threads': '1', 'memory_limit': '256MB', 'enable_external_access': 'false',
    'autoinstall_known_extensions': 'false', 'autoload_known_extensions': 'false',
    'allow_community_extensions': 'false', 'allow_unsigned_extensions': 'false',
})
connection.execute('CREATE TABLE sessions(id VARCHAR, agent VARCHAR, started_at VARCHAR, output_tokens BIGINT, peak_context BIGINT)')
connection.execute('CREATE TABLE usage(session_id VARCHAR, occurred_at VARCHAR, status VARCHAR, source VARCHAR, microdollars BIGINT)')
# Python reads only the app-owned snapshot; SQL has no filesystem or extension access.
with open(sys.argv[1], encoding='utf-8') as snapshot:
    session_rows, usage_rows = [], []
    for line in snapshot:
        value = json.loads(line)
        if value['kind'] == 'session':
            session_rows.append([value[key] for key in ('id', 'agent', 'startedAt', 'outputTokens', 'peakContext')])
        elif value['kind'] == 'usage':
            usage_rows.append([value[key] for key in ('sessionId', 'occurredAt', 'status', 'source', 'microdollars')])
        else:
            raise RuntimeError('Invalid analytics snapshot record')
        if len(session_rows) >= 1000:
            connection.executemany('INSERT INTO sessions VALUES (?,?,?,?,?)', session_rows)
            session_rows.clear()
        if len(usage_rows) >= 1000:
            connection.executemany('INSERT INTO usage VALUES (?,?,?,?,?)', usage_rows)
            usage_rows.clear()
    if session_rows:
        connection.executemany('INSERT INTO sessions VALUES (?,?,?,?,?)', session_rows)
    if usage_rows:
        connection.executemany('INSERT INTO usage VALUES (?,?,?,?,?)', usage_rows)
connection.execute('SET lock_configuration=true')
def records(sql, parameters=None):
    cursor = connection.execute(sql, parameters or [])
    names = [column[0] for column in cursor.description]
    return [dict(zip(names, row)) for row in cursor.fetchall()]
result = {
    'days': records("SELECT coalesce(substr(started_at,1,10),'Unknown') AS day,agent,count(*) sessions,sum(output_tokens) outputTokens,count(output_tokens) tokenSessions,max(peak_context) peakContext,count(peak_context) contextSessions FROM sessions GROUP BY 1,2 ORDER BY 1 DESC,2"),
    'costs': records("SELECT coalesce(substr(occurred_at,1,10),'Unknown') AS day,status,source,count(*) events,count(microdollars) measuredEvents,sum(microdollars) microdollars FROM usage GROUP BY 1,2,3 ORDER BY 1 DESC,2,3"),
    'comparison': [],
}
if len(sys.argv) > 2 and sys.argv[2]:
    result['comparison'] = records("SELECT CASE WHEN try_cast(started_at AS TIMESTAMPTZ) IS NULL THEN 'unknown' WHEN try_cast(started_at AS TIMESTAMPTZ) < cast(? AS TIMESTAMPTZ) THEN 'before' ELSE 'after' END period,agent,count(*) sessions,sum(output_tokens) outputTokens,count(output_tokens) tokenSessions FROM sessions GROUP BY 1,2 ORDER BY 1,2", [sys.argv[2]])
print(json.dumps(result, allow_nan=False))
connection.close()
