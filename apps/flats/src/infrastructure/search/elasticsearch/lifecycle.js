import {getActiveListingsBatch} from '../../database/listingRepository.js';
import {client, ELASTICSEARCH_URL, SEARCH_INDEX} from './client.js';
import {indexDefinition} from './schema.js';
import {indexDbRows} from './documents.js';
import {clearSearchCache} from './query.js';

export async function initElasticsearch() {
    await client.ping();

    const exists = await client.indices.exists({index: SEARCH_INDEX});

    if (!exists) {
        const created = await client.indices.create({
            index: SEARCH_INDEX,
            ...indexDefinition(),
            wait_for_active_shards: 'all',
            timeout: '30s',
        });

        if (created.shards_acknowledged === false) {
            throw new Error(
                `Elasticsearch index ${SEARCH_INDEX} created, but primary shard is not active`,
            );
        }

        console.log(`[elasticsearch] index ${SEARCH_INDEX} created`);
    } else {
        /*
         * Маппинг применяется только при создании индекса, а
         * dynamic:false означает, что новое поле попадёт в
         * _source и никогда — в поиск.
         *
         * Добавление полей — это merge; Elasticsearch отвергает
         * только изменение уже существующих, чего здесь не
         * происходит.
         */
        try {
            await client.indices.putMapping({
                index: SEARCH_INDEX,
                properties: indexDefinition().mappings.properties,
            });

            console.log(
                `[elasticsearch] mappings merged into ${SEARCH_INDEX}`,
            );
        } catch (error) {
            console.warn(
                `[elasticsearch] mapping merge skipped: ${error?.message ?? error}`,
            );
        }
    }

    await client.cluster.health({
        index: SEARCH_INDEX,
        wait_for_status: 'yellow',
        timeout: '30s',
    });

    console.log(`[elasticsearch] connected ${ELASTICSEARCH_URL}`);

    return true;
}

export async function elasticsearchHealth() {
    try {
        const health = await client.cluster.health({requestTimeout: 1000, maxRetries: 0});

        return {
            ok: true,
            status: health.status,
            clusterName: health.cluster_name,
            nodes: health.number_of_nodes,
        };
    } catch (err) {
        return {
            ok: false,
            error: err?.message ?? String(err),
        };
    }
}

export async function rebuildSearchIndex() {
    /*
     * Кэш ранжирования ссылается на документы старого индекса —
     * после пересборки он бессмыслен.
     */
    clearSearchCache();

    await client.ping();

    console.log(`[elasticsearch] rebuilding ${SEARCH_INDEX}`);

    const exists = await client.indices.exists({index: SEARCH_INDEX});

    /*
     * Rebuild означает полный rebuild.
     *
     * Не делаем deleteByQuery: он требует рабочий search shard.
     *
     * Старый индекс нам вообще не нужен, потому что source of
     * truth = Postgres.
     */
    if (exists) {
        console.log(`[elasticsearch] deleting old index ${SEARCH_INDEX}`);
        await client.indices.delete({index: SEARCH_INDEX});
    }

    console.log(`[elasticsearch] creating fresh index ${SEARCH_INDEX}`);

    const created = await client.indices.create({
        index: SEARCH_INDEX,
        ...indexDefinition(),
        /*
         * У нас: shards = 1, replicas = 0. Поэтому all = дождаться
         * единственного primary shard.
         */
        wait_for_active_shards: 'all',
        timeout: '30s',
    });

    if (created.shards_acknowledged === false) {
        /*
         * Сразу получаем нормальную причину, а не падаем потом
         * где-нибудь внутри bulk/search.
         */
        let explanation = null;

        try {
            explanation = await client.cluster.allocationExplain({
                index: SEARCH_INDEX,
                shard: 0,
                primary: true,
            });
        } catch {
            // Не маскируем исходную ошибку.
        }

        throw new Error(
            `Primary shard for ${SEARCH_INDEX} was not allocated. ` +
            (explanation ? JSON.stringify(explanation) : ''),
        );
    }

    /*
     * Дополнительно ждём, пока индекс станет доступен для
     * search/write.
     */
    const health = await client.cluster.health({
        index: SEARCH_INDEX,
        wait_for_status: 'yellow',
        timeout: '30s',
    });

    console.log(`[elasticsearch] index ready: ${health.status}`);

    const BATCH_SIZE = 500;

    let afterId = 0;
    let indexed = 0;

    while (true) {
        const rows = await getActiveListingsBatch(afterId, BATCH_SIZE);

        if (!rows.length) {
            break;
        }

        await indexDbRows(rows);

        indexed += rows.length;
        afterId = rows[rows.length - 1].db_id;

        console.log(`[elasticsearch] indexed ${indexed}`);
    }

    await client.indices.refresh({index: SEARCH_INDEX});

    const count = await client.count({index: SEARCH_INDEX});

    console.log(
        `[elasticsearch] rebuild complete: ${count.count} documents`,
    );

    return {indexed: count.count};
}

export async function closeElasticsearch() {
    await client.close();
}
