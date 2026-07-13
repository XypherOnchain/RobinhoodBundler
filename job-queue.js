/**
 * Per-project job queues + concurrent workers.
 * Replaces the single global job bottleneck for campaign runs.
 * Legacy UI jobs can still use the global `legacyJob` adapter.
 */

const STAGES = [
    "QUEUED",
    "PREFLIGHT",
    "FUNDING",
    "LAUNCHING",
    "BUYING",
    "MONITORING",
    "EXITING",
    "RECALLING",
    "COMPLETE",
    "FAILED",
    "PAUSED",
    "SKIPPED",
];

function createJobQueue({
    maxConcurrent = 3,
    onChange = () => {},
    runStage, // async (projectJob) => nextStage | { stage, error }
}) {
    /** @type {Map<string, object>} projectId -> active job */
    const active = new Map();
    /** @type {object[]} waiting queue */
    const waiting = [];
    let paused = false;
    let ticking = false;

    function snapshot() {
        return {
            paused,
            maxConcurrent,
            active: [...active.values()].map(publicJob),
            waiting: waiting.map(publicJob),
            activeCount: active.size,
            waitingCount: waiting.length,
        };
    }

    function publicJob(j) {
        if (!j) return null;
        return {
            id: j.id,
            campaignId: j.campaignId,
            projectId: j.projectId,
            label: j.label,
            stage: j.stage,
            status: j.status,
            createdAt: j.createdAt,
            updatedAt: j.updatedAt,
            error: j.error || null,
            result: j.result || null,
            progress: j.progress || null,
            logs: (j.logs || []).slice(-40),
        };
    }

    function enqueue(job) {
        const row = {
            id: job.id || `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            campaignId: job.campaignId || null,
            projectId: job.projectId,
            label: job.label || job.projectId,
            stage: job.stage || "QUEUED",
            status: "queued",
            config: job.config || {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            logs: [],
            error: null,
            result: null,
            progress: { done: 0, total: STAGES.length - 2, label: "queued" },
            abort: false,
        };
        waiting.push(row);
        onChange({ type: "enqueued", job: publicJob(row), queue: snapshot() });
        tick();
        return row;
    }

    function pauseAll() {
        paused = true;
        onChange({ type: "paused", queue: snapshot() });
    }

    function resumeAll() {
        paused = false;
        onChange({ type: "resumed", queue: snapshot() });
        tick();
    }

    function abortProject(projectId) {
        const a = active.get(projectId);
        if (a) a.abort = true;
        for (const w of waiting) {
            if (w.projectId === projectId) {
                w.status = "aborted";
                w.stage = "FAILED";
                w.error = "aborted";
            }
        }
        // drop aborted from waiting
        for (let i = waiting.length - 1; i >= 0; i--) {
            if (waiting[i].status === "aborted") waiting.splice(i, 1);
        }
        onChange({ type: "abort", projectId, queue: snapshot() });
    }

    function setMaxConcurrent(n) {
        maxConcurrent = Math.min(20, Math.max(1, Number(n) || 1));
        tick();
    }

    async function tick() {
        if (ticking) return;
        ticking = true;
        try {
            while (!paused && active.size < maxConcurrent && waiting.length) {
                const next = waiting.shift();
                if (!next || next.status === "aborted") continue;
                if (active.has(next.projectId)) {
                    // one active job per project — requeue at end
                    waiting.push(next);
                    break;
                }
                next.status = "running";
                next.stage = next.stage === "QUEUED" ? "PREFLIGHT" : next.stage;
                next.updatedAt = new Date().toISOString();
                active.set(next.projectId, next);
                onChange({ type: "started", job: publicJob(next), queue: snapshot() });
                runJob(next).catch((e) => {
                    next.stage = "FAILED";
                    next.status = "failed";
                    next.error = e.message || String(e);
                    active.delete(next.projectId);
                    onChange({ type: "failed", job: publicJob(next), queue: snapshot() });
                    tick();
                });
            }
        } finally {
            ticking = false;
        }
    }

    async function runJob(job) {
        const push = (msg, kind = "info") => {
            job.logs = job.logs || [];
            job.logs.push({ t: Date.now(), msg, kind });
            if (job.logs.length > 200) job.logs = job.logs.slice(-200);
            job.updatedAt = new Date().toISOString();
            onChange({ type: "log", job: publicJob(job), entry: job.logs[job.logs.length - 1] });
        };

        try {
            while (!job.abort) {
                if (job.stage === "COMPLETE" || job.stage === "FAILED" || job.stage === "SKIPPED") {
                    break;
                }
                if (job.stage === "PAUSED") {
                    job.status = "paused";
                    active.delete(job.projectId);
                    onChange({ type: "job_paused", job: publicJob(job), queue: snapshot() });
                    return;
                }

                push(`Stage → ${job.stage}`, "info");
                job.progress = {
                    done: Math.max(0, STAGES.indexOf(job.stage)),
                    total: 8,
                    label: job.stage.toLowerCase(),
                };
                onChange({ type: "progress", job: publicJob(job), queue: snapshot() });

                const out = await runStage(job, { push, shouldAbort: () => job.abort });
                if (job.abort) {
                    job.stage = "FAILED";
                    job.error = "aborted";
                    break;
                }
                if (!out) {
                    job.stage = "FAILED";
                    job.error = "stage returned nothing";
                    break;
                }
                if (out.error) {
                    job.stage = "FAILED";
                    job.error = out.error;
                    push(out.error, "err");
                    break;
                }
                if (out.result) job.result = { ...(job.result || {}), ...out.result };
                job.stage = out.stage || job.stage;
                job.updatedAt = new Date().toISOString();
            }
        } catch (e) {
            job.stage = "FAILED";
            job.error = e.message || String(e);
            push(job.error, "err");
        }

        job.status =
            job.stage === "COMPLETE"
                ? "complete"
                : job.stage === "SKIPPED"
                  ? "skipped"
                  : "failed";
        job.updatedAt = new Date().toISOString();
        active.delete(job.projectId);
        onChange({
            type: job.status === "complete" ? "complete" : "failed",
            job: publicJob(job),
            queue: snapshot(),
        });
        tick();
    }

    return {
        STAGES,
        enqueue,
        pauseAll,
        resumeAll,
        abortProject,
        setMaxConcurrent,
        snapshot,
        publicJob,
        getActive: (projectId) => active.get(projectId) || null,
        isBusy: () => active.size > 0 || waiting.length > 0,
    };
}

module.exports = { createJobQueue, STAGES };
