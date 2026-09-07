"""Summarize native trial receipts without treating partial runs as completed scores."""
import argparse
import json
from datetime import datetime
from pathlib import Path
from statistics import median

parser = argparse.ArgumentParser()
parser.add_argument('--metrics', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('receipts', type=Path, nargs='+')
args = parser.parse_args()
metrics = json.loads(args.metrics.read_text())
rows = []
for path in args.receipts:
    trial = json.loads(path.read_text())
    start, end = (datetime.fromisoformat(trial[key]) for key in ['startedAt', 'finishedAt'])
    calls = [call for call in metrics if call['candidate'] == trial['engine'] and start <= datetime.fromisoformat(call['at']) <= end]
    llm = [call for call in calls if call['operation'] == 'chat/completions']
    queries = trial['queries']
    usage = [call['usage'] for call in llm if isinstance(call.get('usage'), dict)]
    rows.append({
        'receipt': path.name, 'engine': trial['engine'], 'corpusSha256': trial['corpusSha256'],
        'complete': trial['complete'], 'closed': trial.get('closed', False),
        'strictSchemaOverride': trial.get('strictSchemaOverride', False),
        'embeddingDimensions': trial['embeddingDimensions'],
        'retainedDocuments': len(trial['retained']), 'returnedQueries': len(queries),
        'correctAnswers': sum(q.get('answerCorrect', False) for q in queries),
        'forbiddenSourceLeaks': sum(q['forbiddenSourceLeak'] for q in queries),
        'errors': trial['errors'],
        'retentionMs': sum(item['ms'] for item in trial['retained']),
        'medianRetrievalMs': median(q['ms'] for q in queries) if queries else None,
        'totalMs': trial['totalMs'], 'derivedBytes': trial['derivedBytes'],
        'pythonPeakRssBytes': trial['pythonPeakRssBytes'],
        'reapedChildPeakRssBytes': trial.get('reapedChildPeakRssBytes'),
        'modelCalls': len(llm), 'callsWithUsage': len(usage),
        'inputTokens': sum(u['prompt_tokens'] for u in usage) if usage else None,
        'outputTokens': sum(u['completion_tokens'] for u in usage) if usage else None,
        'embeddingCalls': sum(c['operation'] == 'embeddings' for c in calls),
        'rerankCalls': sum(c['operation'] == 'rerank' for c in calls),
    })
    assert not trial['complete'] or not trial['errors']
    assert rows[-1]['correctAnswers'] <= rows[-1]['returnedQueries']
args.output.write_text(json.dumps({
    'limitations': [
        'Token usage includes extraction, retrieval and source-assisted answers; it is not billed cost.',
        'Retention time includes successful insert operations; failed extraction time is included only in total time.',
        'Python and reaped-child RSS are separate process maxima, not simultaneous process-tree or model-server memory.',
        'The baseline embeds and reranks in its own native child; those calls are absent from bridge metrics.',
        'Different corpus hashes, incomplete runs and uncontrolled host/cache conditions must remain explicit.',
    ], 'trials': rows,
}, indent=2) + '\n')
print(json.dumps({'receipts': len(rows), 'complete': sum(row['complete'] for row in rows)}))
