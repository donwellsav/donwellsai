"""Bounded Graphiti 0.30.1 operations; input is owned by the desktop knowledge owner."""
import asyncio
import json
import re
import sys
from datetime import datetime
from importlib.metadata import version

# One bounded startup read of the Neo4j password from the anonymous stdin pipe,
# which the desktop owner closes immediately. The bytes are never forwarded to a
# descendant, never logged, and never placed in the request document; they live
# only in this process's memory for the duration of the run.
MAX_PASSWORD_BYTES = 4096


def read_password():
    raw = sys.stdin.buffer.read(MAX_PASSWORD_BYTES + 1)
    if not raw:
        raise ValueError('Graphiti worker requires the Neo4j password on stdin')
    if len(raw) > MAX_PASSWORD_BYTES:
        raise ValueError('Graphiti worker received an oversized Neo4j password')
    password = raw.decode('utf-8')
    if not password or any(ord(char) < 32 or ord(char) == 127 for char in password):
        raise ValueError('Graphiti worker received an invalid Neo4j password')
    return password


async def main():
    if version('graphiti-core') != '0.30.1':
        raise ValueError('Graphiti worker requires graphiti-core 0.30.1')
    password = read_password()
    with open(sys.argv[1], encoding='utf-8') as source:
        request = json.load(source)
    group = request['group']
    if not re.fullmatch(r'donwells-[a-f0-9]{64}-[a-f0-9-]{36}', group):
        raise ValueError('Invalid project-owned Graphiti group')
    from graphiti_core import Graphiti
    from graphiti_core.driver.neo4j_driver import Neo4jDriver
    from graphiti_core.llm_client.config import LLMConfig
    from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient
    from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
    from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient
    from graphiti_core.nodes import EpisodeType, EpisodicNode
    from graphiti_core.search.search_filters import SearchFilters, DateFilter, ComparisonOperator as Op
    from graphiti_core.utils.maintenance.graph_data_operations import clear_data
    config = request['configuration']
    driver = Neo4jDriver(config['neo4jUri'], config['neo4jUser'], password)
    password = None
    llm_config = LLMConfig(api_key='local', base_url=config['modelUrl'], model=config['model'], small_model=config['model'], max_tokens=4096)
    graph = Graphiti(graph_driver=driver, llm_client=OpenAIGenericClient(llm_config, max_tokens=4096), embedder=OpenAIEmbedder(OpenAIEmbedderConfig(api_key='local', base_url=config['embeddingUrl'], embedding_model=config['embeddingModel'], embedding_dim=config['embeddingDimensions'])), cross_encoder=OpenAIRerankerClient(llm_config), max_coroutines=1)
    try:
        operation = request['operation']
        if operation == 'delete':
            await clear_data(driver, group_ids=[group])
            records, _, _ = await driver.execute_query('MATCH (n) WHERE n.group_id = $group RETURN count(n) AS remaining', group=group)
            if records[0]['remaining'] != 0:
                raise ValueError('Graphiti group deletion incomplete')
            result = {'deleted': True, 'group': group}
        elif operation == 'retain':
            await graph.build_indices_and_constraints()
            receipts = []
            for source in request['sources']:
                # Owner submits each fresh generation once. Interrupted generations are deleted, never replayed.
                reference_time = datetime.fromisoformat(source['availableFrom'].replace('Z', '+00:00'))
                previous = await graph.retrieve_episodes(reference_time, last_n=3, group_ids=[group], source=EpisodeType.text)
                # In 0.30.1 uuid selects an existing episode; persist our owned ID before extraction.
                episode = EpisodicNode(uuid=source['episodeId'], name=source['episodeId'], group_id=group, source=EpisodeType.text, content=source['content'], source_description=json.dumps(source['ref']), valid_at=reference_time)
                await episode.save(driver)
                added = await graph.add_episode(name=episode.name, episode_body=episode.content, source_description=episode.source_description, reference_time=reference_time, source=EpisodeType.text, group_id=group, uuid=episode.uuid, previous_episode_uuids=[item.uuid for item in previous], update_communities=False)
                if added.episode.group_id != group:
                    raise ValueError('Graphiti returned a foreign episode')
                receipts.append({'episode': added.episode.uuid, 'edges': [edge.uuid for edge in added.edges]})
            result = {'group': group, 'receipts': receipts}
        elif operation == 'query':
            instant = datetime.fromisoformat(request['asOf'].replace('Z', '+00:00'))
            filters = SearchFilters(valid_at=[[DateFilter(date=instant, comparison_operator=Op.less_than_equal)], [DateFilter(comparison_operator=Op.is_null)]], invalid_at=[[DateFilter(date=instant, comparison_operator=Op.greater_than)], [DateFilter(comparison_operator=Op.is_null)]])
            edges = await graph.search(request['query'], group_ids=[group], num_results=20, search_filter=filters)
            result = {'group': group, 'edges': [edge.model_dump(mode='json') for edge in edges if edge.group_id == group]}
        else:
            raise ValueError('Unknown Graphiti operation')
        print(json.dumps(result))
    finally:
        await graph.close()

if __name__ == '__main__':
    asyncio.run(main())
