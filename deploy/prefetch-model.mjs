// AI: Скачивает модель эмбеддингов в RAG_MODEL_DIR при сборке образа, чтобы свежий контейнер
// отвечал с первой секунды и никогда не нуждался в выходе в интернет ради поиска.
import { env, pipeline } from '@huggingface/transformers';

const model = process.env.RAG_EMBEDDING_MODEL ?? 'Xenova/multilingual-e5-small';
env.cacheDir = process.env.RAG_MODEL_DIR ?? './data/models';

const extractor = await pipeline('feature-extraction', model, { dtype: 'q8' });
const out = await extractor(['passage: проверка'], { pooling: 'mean', normalize: true });
console.log(`${model}: ${out.dims.at(-1)} dims, cached in ${env.cacheDir}`);
