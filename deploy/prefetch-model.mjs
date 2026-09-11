// AI: Downloads the embedding model into RAG_MODEL_DIR at image build time, so a fresh container
// answers from the first second and never needs outbound internet for retrieval.
import { env, pipeline } from '@huggingface/transformers';

const model = process.env.RAG_EMBEDDING_MODEL ?? 'Xenova/multilingual-e5-small';
env.cacheDir = process.env.RAG_MODEL_DIR ?? './data/models';

const extractor = await pipeline('feature-extraction', model, { dtype: 'q8' });
const out = await extractor(['passage: проверка'], { pooling: 'mean', normalize: true });
console.log(`${model}: ${out.dims.at(-1)} dims, cached in ${env.cacheDir}`);
