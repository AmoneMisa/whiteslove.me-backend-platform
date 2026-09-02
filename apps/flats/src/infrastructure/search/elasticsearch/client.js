import {Client} from '@elastic/elasticsearch';

const ELASTICSEARCH_URL =
    process.env.ELASTICSEARCH_URL ||
    'http://flat-finder-elasticsearch:9200';

export const SEARCH_INDEX =
    process.env.ELASTICSEARCH_INDEX ||
    'flat-listings-v1';

export const client = new Client({
    node: ELASTICSEARCH_URL,
    maxRetries: 3,
    requestTimeout: 15_000,
});

export {ELASTICSEARCH_URL};
