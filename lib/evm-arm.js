/**
 * EVM money-path arm gates (from stealth-bundler).
 * Real broadcasts require EVM_ARM_LIVE=true plus an explicit per-call arm where used.
 */
function envTrue(name) {
    const v = String(process.env[name] || "").toLowerCase();
    return v === "1" || v === "true" || v === "yes";
}

function evmArmLive() {
    return envTrue("EVM_ARM_LIVE");
}

function noxaArmLive() {
    return envTrue("NOXA_ARM_LIVE");
}

function koaArmLive() {
    return envTrue("KOA_ARM_LIVE");
}

function apestoreArmLive() {
    // Default: follow EVM_ARM_LIVE unless explicitly set
    if (process.env.APESTORE_ARM_LIVE == null || process.env.APESTORE_ARM_LIVE === "") {
        return evmArmLive();
    }
    return envTrue("APESTORE_ARM_LIVE");
}

/** Launchpad-specific arm (extra opt-in on top of EVM_ARM_LIVE when set). */
function launchpadArmed(pad) {
    if (!evmArmLive()) return false;
    const p = String(pad || "noxa").toLowerCase();
    if (p === "koa") return koaArmLive() || !process.env.KOA_ARM_LIVE;
    if (p === "apestore" || p === "ape") return apestoreArmLive();
    if (p === "noxa") return noxaArmLive() || !process.env.NOXA_ARM_LIVE;
    return true;
}

/** Chart pattern / bump: need global EVM arm + job.armedLive */
function automationLive(job) {
    if (!evmArmLive()) return false;
    if (!job) return false;
    if (job.jobType === "chart_pattern" || job.job_type === "chart_pattern") {
        return Number(job.armedLive ?? job.armed_live) === 1;
    }
    return true;
}

module.exports = {
    envTrue,
    evmArmLive,
    noxaArmLive,
    koaArmLive,
    apestoreArmLive,
    launchpadArmed,
    automationLive,
};
