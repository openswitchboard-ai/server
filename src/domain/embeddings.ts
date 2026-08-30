/**
 * Card embeddings (Titan Text Embeddings v2, 1024-dim) over the canonical
 * projection text (matchRules.projectionText - category label path + sorted
 * attribute summary, never a raw free-text dump).
 *
 * NO-FALLBACKS: if Bedrock is unavailable or returns a malformed vector, the
 * caller's SQS message redelivers - a card is never published (or matched)
 * with a missing/fake embedding.
 */
import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrock } from '../aws.js';
import { getPool } from '../db.js';
import { projectionText } from './matchRules.js';
import type { CardRow } from './cards.js';
import type { Config } from '../config.js';

export const EMBEDDING_DIMS = 1024;

export async function embedText(cfg: Config, text: string): Promise<number[]> {
  const r = await bedrock.send(
    new InvokeModelCommand({
      modelId: cfg.bedrockEmbedModelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ inputText: text, dimensions: EMBEDDING_DIMS, normalize: true }),
    }),
  );
  const parsed = JSON.parse(new TextDecoder().decode(r.body));
  const v = parsed.embedding;
  if (!Array.isArray(v) || v.length !== EMBEDDING_DIMS || typeof v[0] !== 'number') {
    throw new Error(
      `embedding model ${cfg.bedrockEmbedModelId} returned a malformed vector (len=${v?.length})`,
    );
  }
  return v as number[];
}

export function vectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

/** Embed one card's projection and store it. Returns the projection text. */
export async function embedCard(
  cfg: Config,
  card: Pick<CardRow, 'id' | 'category' | 'attributes'>,
): Promise<string> {
  const text = projectionText(card);
  const vec = await embedText(cfg, text);
  await getPool().query(`UPDATE cards SET embedding = $2::vector, updated_at = now() WHERE id = $1`, [
    card.id,
    vectorLiteral(vec),
  ]);
  return text;
}

/**
 * Backfill: embed every PUBLISHED card missing an embedding, then hand each
 * to the matching queue. Driven by the internal ops queue (op:
 * 'backfill-embeddings'); idempotent and safe to re-run.
 */
export async function backfillEmbeddings(
  cfg: Config,
  enqueueMatch: (cardId: string) => Promise<void>,
): Promise<number> {
  const r = await getPool().query(
    `SELECT id, category, attributes FROM cards
     WHERE embedding IS NULL AND lifecycle_state = 'PUBLISHED' AND expires_at > now()
     ORDER BY created_at ASC LIMIT 500`,
  );
  for (const row of r.rows) {
    await embedCard(cfg, row);
    await enqueueMatch(row.id);
  }
  return r.rowCount ?? 0;
}
