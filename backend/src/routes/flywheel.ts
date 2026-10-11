import { FastifyInstance } from 'fastify';
import { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { FlywheelDataset } from '../flywheel/dataset.js';
import { FlywheelTrainer } from '../flywheel/trainer.js';
import { FLYWHEEL_TIERS, FlywheelLabelSource, isTier } from '../flywheel/schema.js';
import { TierLevel } from '../types/router.js';
import path from 'node:path';

/**
 * Flywheel console API — dataset inspection, operator relabelling and manual
 * Layer 1 training.
 *
 * The dataset is the append-only JSONL written by the collector; relabelling
 * writes a sidecar overlay, so nothing here mutates recorded history. The
 * training guard lives in FlywheelTrainer (one run at a time) and is mirrored
 * by a 409 here, so a second console tab cannot schedule a duplicate run.
 */

const VALID_SOURCES: FlywheelLabelSource[] = ['human', 'runtime_fallback', 'observed_execution', 'unlabeled'];

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

  app.get('/api/admin/flywheel/stats', async () => {
    return {
      ...dataset.summary(),
      process: orchestrator.getFlywheel().getStats(),
      tiers: FLYWHEEL_TIERS,
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
      const updated = dataset.setLabel(id, body.tier === null ? null : (body.tier as TierLevel));
      if (!updated) return reply.status(404).send({ error: `Unknown sample id: ${id}` });
      return { ok: true, label: updated.label };
    } catch (err: any) {
      return reply.status(400).send({ error: err?.message || String(err) });
    }
  });

  app.delete('/api/admin/flywheel/labels', async () => {
    const cleared = dataset.clearOverrides();
    return { ok: true, cleared };
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
