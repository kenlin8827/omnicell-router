import { FastifyInstance } from 'fastify';
import { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { FlywheelDataset } from '../flywheel/dataset.js';
import { FlywheelTrainer } from '../flywheel/trainer.js';
import { PruneOptions, deleteRecordsById, pruneDataset, resetDataset } from '../flywheel/prune.js';
import { FLYWHEEL_TIERS, FlywheelLabelSource, isTier } from '../flywheel/schema.js';
import { TierLevel } from '../types/router.js';
import path from 'node:path';

/**
 * Flywheel console API — dataset inspection, operator relabelling, manual
 * Layer 1 training and the dataset lifecycle operations (prune / batch
 * delete / reset).
 *
 * The dataset is append-only under normal operation; the destructive POSTs
 * below discard whole records through the shared rewrite engine
 * (`flywheel/prune.ts`) under its documented backup policy (design doc D3),
 * never by mutating history in place — corrections remain overlay-only via
 * `setLabel`. Every successful rewrite calls `dataset.invalidate()` so the
 * read side re-indexes before responding. The training guard lives in
 * FlywheelTrainer (one run at a time) and is mirrored by a 409 here, so a
 * second console tab cannot schedule a duplicate run — or a rewrite that
 * races one. Auth: inherits the /api/admin webAuth gate unchanged.
 */

const VALID_SOURCES: FlywheelLabelSource[] = ['human', 'runtime_fallback', 'observed_execution', 'unlabeled'];

/** Batch-delete cap per call (§3.2): a re-click after partial failure is safe, a giant POST is not. */
const MAX_DELETE_IDS = 1000;

/** Lifecycle POST bodies are optional JSON objects; absent = endpoint defaults. */
function asObjectBody(body: unknown): Record<string, unknown> | null {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

export function registerFlywheelRoutes(app: FastifyInstance, orchestrator: PipelineOrchestrator): void {
  const datasetPath = orchestrator.getFlywheel().getDatasetPath();
  const dataset = new FlywheelDataset(datasetPath);
  const modelPath =
    orchestrator.getClassifierConfig()?.localModel?.modelPath ||
    path.resolve(process.cwd(), 'models/layer1-classifier.json');
  const trainer = new FlywheelTrainer(
    dataset,
    modelPath,
    orchestrator.getFlywheelConfig()?.maxSamples,
    // Whether the router's confidence gate consumes trained weights. Mirrors
    // the orchestrator's config snapshot: editing config.yaml alone does not
    // flip this until a gateway restart, and the console must say so.
    orchestrator.getClassifierConfig()?.localModel?.enabled === true
  );

  // A pre-existing multi-hundred-MB dataset takes one cold pass to index; walk
  // it down in slices so the first console visit doesn't pay for it all at once.
  dataset.warmup();

  app.get('/api/admin/flywheel/stats', async () => {
    return {
      ...dataset.summary(),
      process: orchestrator.getFlywheel().getStats(),
      tiers: FLYWHEEL_TIERS,
      // Additive block (§3.4): effective retention knobs + last sweep outcome.
      retention: orchestrator.getFlywheel().getRetentionState(),
    };
  });

  app.get('/api/admin/flywheel/samples', async (req) => {
    const q = req.query as any;
    const tierParam = typeof q.tier === 'string' ? q.tier : undefined;
    const tier: TierLevel | 'none' | 'any' | undefined = isTier(tierParam)
      ? tierParam
      : tierParam === 'none'
        ? 'none'
        : 'any';
    const sourceParam = typeof q.source === 'string' ? q.source : undefined;
    const source = VALID_SOURCES.includes(sourceParam as FlywheelLabelSource)
      ? (sourceParam as FlywheelLabelSource)
      : 'any';

    const result = dataset.query({
      limit: q.limit !== undefined ? Number(q.limit) : undefined,
      offset: q.offset !== undefined ? Number(q.offset) : undefined,
      tier,
      source,
      includeSynthetic: q.includeSynthetic === 'true' || q.includeSynthetic === true,
      trainableOnly: q.trainableOnly === 'true' || q.trainableOnly === true,
      search: typeof q.search === 'string' && q.search.trim() ? q.search.trim() : undefined,
    });
    return { ...result, tiers: FLYWHEEL_TIERS };
  });

  // Operator relabelling. `{ "tier": "pro" }` sets a human label,
  // `{ "tier": null }` clears it back to the observed label.
  app.patch('/api/admin/flywheel/samples/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body || {}) as { tier?: unknown };

    if (!(body.tier === null || isTier(body.tier))) {
      return reply.status(400).send({ error: `tier must be null or one of: ${FLYWHEEL_TIERS.join(', ')}` });
    }
    if (trainer.isTraining()) {
      return reply.status(409).send({ error: 'A training run is in progress; relabelling is paused.' });
    }

    try {
      const label = dataset.setLabel(id, body.tier === null ? null : (body.tier as TierLevel));
      if (!label) return reply.status(404).send({ error: `Unknown sample id: ${id}` });
      return { ok: true, label };
    } catch (err: any) {
      return reply.status(400).send({ error: err?.message || String(err) });
    }
  });

  app.delete('/api/admin/flywheel/labels', async () => {
    const cleared = dataset.clearOverrides();
    return { ok: true, cleared };
  });

  // ---- dataset lifecycle: prune / batch delete / reset (§3, frozen contract) ----
  // All three share: JSON-object body (absent = defaults), 409 while training,
  // engine-side atomic tmp+rename rewrites, dataset.invalidate() after a real
  // rewrite, and labels-overlay orphan purge inside the engine (D9).

  // Dry-run default like the CLI: preview performs zero writes; apply rewrites
  // with a full `.bak-<ts>` backup, rotation keeps the newest 3.
  app.post('/api/admin/flywheel/prune', async (req, reply) => {
    const body = asObjectBody(req.body);
    if (!body) return reply.status(400).send({ error: 'Body must be a JSON object' });
    const boolField = (['apply', 'dropSynthetic', 'dropDuplicates', 'dropLegacy'] as const).find(
      (k) => body[k] !== undefined && typeof body[k] !== 'boolean'
    );
    if (boolField) return reply.status(400).send({ error: `"${boolField}" must be a boolean` });
    if (trainer.isTraining()) {
      return reply.status(409).send({ error: 'A training run is in progress; pruning is paused.' });
    }

    const opts: PruneOptions = {
      dropSynthetic: body.dropSynthetic !== false,
      dropDuplicates: body.dropDuplicates !== false,
      dropLegacy: body.dropLegacy === true,
    };
    try {
      const outcome = pruneDataset(datasetPath, opts, body.apply === true);
      if (!outcome) return reply.status(404).send({ error: `No dataset file at ${datasetPath}` });
      if (outcome.applied) dataset.invalidate();
      return {
        ok: true,
        applied: outcome.applied,
        total: outcome.total,
        kept: outcome.kept,
        dropped: outcome.dropped,
        removedLabels: outcome.removedLabels,
        backupPath: outcome.backupPath,
      };
    } catch (err: any) {
      return reply.status(400).send({ error: err?.message || String(err) });
    }
  });

  // Partial-success + idempotent (§3.2): unknown ids are reported, never an
  // error; a re-click after a partial failure is safe. Removed lines land
  // verbatim in the `.deleted.jsonl` sidecar (D3).
  app.post('/api/admin/flywheel/samples/delete', async (req, reply) => {
    const body = asObjectBody(req.body);
    if (!body) return reply.status(400).send({ error: 'Body must be a JSON object' });
    const ids = body.ids;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > MAX_DELETE_IDS ||
      ids.some((id) => typeof id !== 'string' || id === '')
    ) {
      return reply.status(400).send({ error: `ids must be an array of 1-${MAX_DELETE_IDS} non-empty strings` });
    }
    if (trainer.isTraining()) {
      return reply.status(409).send({ error: 'A training run is in progress; deletion is paused.' });
    }

    try {
      const outcome = deleteRecordsById(datasetPath, ids as string[]);
      if (outcome.rewrote) dataset.invalidate();
      return {
        ok: true,
        deleted: outcome.deleted,
        notFound: outcome.notFound,
        removedLabels: outcome.removedLabels,
        sidecarPath: outcome.sidecarPath,
      };
    } catch (err: any) {
      return reply.status(400).send({ error: err?.message || String(err) });
    }
  });

  // Typed confirmation guards RESET only (D6) — the engine clears the dataset
  // AND the labels overlay (both archived) and NEVER touches the trained model
  // files; `modelUntouched: true` is a contract promise, not just a fact (D8).
  app.post('/api/admin/flywheel/reset', async (req, reply) => {
    const body = asObjectBody(req.body);
    if (!body) return reply.status(400).send({ error: 'Body must be a JSON object' });
    if (body.confirm !== 'RESET') {
      return reply
        .status(400)
        .send({ error: 'Body must include { "confirm": "RESET" } (exact, case-sensitive).' });
    }
    if (trainer.isTraining()) {
      return reply.status(409).send({ error: 'A training run is in progress; reset is paused.' });
    }

    try {
      const outcome = resetDataset(datasetPath);
      if (outcome.datasetRewrote || outcome.labelsBackupPath) dataset.invalidate();
      return {
        ok: true,
        removedRecords: outcome.removedRecords,
        removedLabels: outcome.removedLabels,
        backupPath: outcome.backupPath,
        labelsBackupPath: outcome.labelsBackupPath,
        modelUntouched: true,
      };
    } catch (err: any) {
      return reply.status(400).send({ error: err?.message || String(err) });
    }
  });

  app.get('/api/admin/flywheel/training', async () => {
    return { ...trainer.getState(), model: trainer.modelInfo() };
  });

  // Restore the weights this model had before the last training run.
  app.post('/api/admin/flywheel/model/rollback', async (_req, reply) => {
    if (trainer.isTraining()) {
      return reply.status(409).send({ error: 'A training run is in progress; rollback is paused.' });
    }
    if (!trainer.rollback()) {
      return reply.status(404).send({ error: 'No pre-training backup exists — nothing to roll back to.' });
    }
    return { ok: true, model: trainer.modelInfo() };
  });

  app.post('/api/admin/flywheel/training', async (req, reply) => {
    if (trainer.isTraining()) {
      return reply.status(409).send({ error: 'A training run is already in progress.', state: trainer.getState() });
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const outcome = await trainer.train({
      epochs: typeof body.epochs === 'number' ? body.epochs : undefined,
      lr: typeof body.lr === 'number' ? body.lr : undefined,
      l2: typeof body.l2 === 'number' ? body.l2 : undefined,
      maxSamples: typeof body.maxSamples === 'number' ? body.maxSamples : undefined,
      balanceClasses: body.balanceClasses === true,
      includeSynthetic: body.includeSynthetic === true,
      minLabelSource:
        body.minLabelSource === 'human' || body.minLabelSource === 'runtime_fallback'
          ? body.minLabelSource
          : undefined,
    });

    if (outcome.error) {
      return reply.status(400).send({ error: outcome.error, state: outcome.state });
    }
    return outcome;
  });
}
