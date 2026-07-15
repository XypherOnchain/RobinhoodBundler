/**
 * Wallet safety — never send value to an address whose private key
 * is not already persisted on disk (CPO postmortem S1/S2/B3).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const tenant = require("./tenant-context");

function DATA_DIR() {
  return tenant.getDataDir();
}
function LEGS_DIR() {
  return path.join(DATA_DIR(), "legs");
}
function KEY_INDEX() {
  return path.join(DATA_DIR(), "known-key-addresses.json");
}

function ensureDirs() {
  fs.mkdirSync(LEGS_DIR(), { recursive: true });
  fs.mkdirSync(DATA_DIR(), { recursive: true });
}

function normAddr(a) {
  return String(a || "").toLowerCase();
}

function loadKeyIndex() {
  ensureDirs();
  try {
    return JSON.parse(fs.readFileSync(KEY_INDEX(), "utf8"));
  } catch {
    return { addresses: {}, updatedAt: null };
  }
}

function saveKeyIndex(idx) {
  ensureDirs();
  idx.updatedAt = new Date().toISOString();
  fs.writeFileSync(KEY_INDEX(), JSON.stringify(idx, null, 2));
  try {
    fs.chmodSync(KEY_INDEX(), 0o600);
  } catch (_) {}
}

/**
 * Register that we control `address` with a key already on disk.
 * Does NOT store the private key here — only the address + source file.
 */
function registerControlledAddress(address, sourceFile, meta = {}) {
  const addr = normAddr(address);
  if (!/^0x[a-f0-9]{40}$/.test(addr)) {
    throw new Error(`registerControlledAddress: bad address ${address}`);
  }
  const idx = loadKeyIndex();
  idx.addresses[addr] = {
    sourceFile: String(sourceFile || ""),
    registeredAt: new Date().toISOString(),
    ...meta,
  };
  saveKeyIndex(idx);
  return idx.addresses[addr];
}

function isAddressControlled(address) {
  const idx = loadKeyIndex();
  return !!idx.addresses[normAddr(address)];
}

/**
 * Persist an array of leg wallets BEFORE any payment.
 * Each leg: { name, address, privateKey|private_key|basePk|rhPk, ... }
 * Writes encrypted-optional JSON and registers every address.
 */
function persistLegsBeforePay(jobId, legs, options = {}) {
  ensureDirs();
  if (!jobId) throw new Error("persistLegsBeforePay: jobId required");
  if (!Array.isArray(legs) || !legs.length) {
    throw new Error("persistLegsBeforePay: legs required");
  }

  const outPath = path.join(LEGS_DIR(), `${jobId}.json`);
  const rows = legs.map((leg, i) => {
    const pk =
      leg.privateKey ||
      leg.private_key ||
      leg.basePk ||
      leg.rhPk ||
      null;
    const address = leg.address || leg.baseAddress || leg.rhAddress;
    if (!address) throw new Error(`leg ${i}: missing address`);
    if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(String(pk))) {
      throw new Error(
        `leg ${i} (${leg.name || address}): missing/invalid private key — refusing to persist incomplete legs`
      );
    }
    return {
      name: leg.name || `L${i + 1}`,
      address,
      privateKey: pk,
      baseAddress: leg.baseAddress || null,
      basePk: leg.basePk || null,
      rhAddress: leg.rhAddress || null,
      rhPk: leg.rhPk || null,
      buyerAddress: leg.buyerAddress || null,
      amountEth:
        leg.amountEth != null && Number.isFinite(Number(leg.amountEth))
          ? Number(leg.amountEth)
          : null,
      meta: leg.meta || {},
    };
  });

  // Verify every row has a key that matches address when ethers is available
  let ethers;
  try {
    ethers = require("ethers");
  } catch (_) {}
  if (ethers) {
    for (const r of rows) {
      const w = new ethers.Wallet(r.privateKey);
      if (w.address.toLowerCase() !== String(r.address).toLowerCase()) {
        // allow multi-key legs: check base/rh
        const baseOk =
          r.basePk &&
          new ethers.Wallet(r.basePk).address.toLowerCase() ===
            String(r.baseAddress || "").toLowerCase();
        const rhOk =
          r.rhPk &&
          new ethers.Wallet(r.rhPk).address.toLowerCase() ===
            String(r.rhAddress || "").toLowerCase();
        if (!baseOk && !rhOk) {
          throw new Error(
            `leg ${r.name}: private key does not derive to address ${r.address}`
          );
        }
      }
      if (r.baseAddress && r.basePk) {
        const bw = new ethers.Wallet(r.basePk);
        if (bw.address.toLowerCase() !== r.baseAddress.toLowerCase()) {
          throw new Error(`leg ${r.name}: basePk mismatch`);
        }
      }
      if (r.rhAddress && r.rhPk) {
        const rw = new ethers.Wallet(r.rhPk);
        if (rw.address.toLowerCase() !== r.rhAddress.toLowerCase()) {
          throw new Error(`leg ${r.name}: rhPk mismatch`);
        }
      }
    }
  }

  const payload = {
    savedAt: new Date().toISOString(),
    jobId,
    purpose: options.purpose || "pre-pay wallet persistence",
    legs: rows,
    checksum: crypto
      .createHash("sha256")
      .update(rows.map((r) => r.address + r.privateKey).join("|"))
      .digest("hex")
      .slice(0, 16),
  };

  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  try {
    fs.chmodSync(outPath, 0o600);
  } catch (_) {}

  // Round-trip verify
  const readBack = JSON.parse(fs.readFileSync(outPath, "utf8"));
  if (!readBack.legs || readBack.legs.length !== rows.length) {
    throw new Error("persistLegsBeforePay: round-trip verify failed");
  }
  for (const r of readBack.legs) {
    if (!r.privateKey && !r.basePk && !r.rhPk) {
      throw new Error("persistLegsBeforePay: keys missing after write");
    }
    registerControlledAddress(r.address, outPath, { jobId, name: r.name });
    if (r.baseAddress && r.basePk) {
      registerControlledAddress(r.baseAddress, outPath, {
        jobId,
        name: r.name + "-base",
      });
    }
    if (r.rhAddress && r.rhPk) {
      registerControlledAddress(r.rhAddress, outPath, {
        jobId,
        name: r.name + "-rh",
      });
    }
  }

  return { path: outPath, count: rows.length, checksum: payload.checksum };
}

/**
 * Hard gate: refuse outbound payment to `toAddress` unless we control it
 * OR it is an explicit external destination (CEX/payin) marked allowExternal.
 */
function assertCanSendTo(toAddress, options = {}) {
  const addr = normAddr(toAddress);
  if (!/^0x[a-f0-9]{40}$/.test(addr)) {
    throw new Error(`assertCanSendTo: invalid address ${toAddress}`);
  }
  if (options.allowExternal === true) {
    // ChangeNOW payin, Across spoke, router — we don't hold these keys
    return { ok: true, external: true };
  }
  if (options.requireControlled === false) return { ok: true };
  if (!isAddressControlled(addr) && !options.knownFromStore) {
    // Also accept if caller proves key is in the same request payload already on disk
    if (options.legsFile && fs.existsSync(options.legsFile)) {
      try {
        const j = JSON.parse(fs.readFileSync(options.legsFile, "utf8"));
        const hit = (j.legs || []).some(
          (l) =>
            normAddr(l.address) === addr ||
            normAddr(l.baseAddress) === addr ||
            normAddr(l.rhAddress) === addr
        );
        if (hit) return { ok: true, fromLegsFile: true };
      } catch (_) {}
    }
    throw new Error(
      `SAFETY: refusing to send value to ${toAddress} — private key not registered on disk. Persist keys first (S1).`
    );
  }
  return { ok: true };
}

/**
 * Preflight for ChangeNOW/Across clean cycles.
 */
function assertLegsReadyForPay(legsFile) {
  if (!legsFile || !fs.existsSync(legsFile)) {
    throw new Error(
      "SAFETY: legs file missing — generate + persist keys before ChangeNOW/Across payments (S2)"
    );
  }
  const j = JSON.parse(fs.readFileSync(legsFile, "utf8"));
  const legs = j.legs || [];
  if (!legs.length) throw new Error("SAFETY: legs file empty");
  for (const leg of legs) {
    const hasBase = !!(leg.basePk && leg.baseAddress);
    const hasRh = !!(leg.rhPk && leg.rhAddress);
    const hasSingle = !!(leg.privateKey && leg.address);
    if (!hasBase && !hasRh && !hasSingle) {
      throw new Error(
        `SAFETY: leg ${leg.name || "?"} missing keys in ${legsFile}`
      );
    }
  }
  return { ok: true, count: legs.length, path: legsFile };
}

/** Sync register all wallet addresses from dashboard store (no new keys). */
function registerStoreWallets(store) {
  const list = [];
  for (const w of store.wallets || []) {
    if (w.address && (w.private_key || w.privateKey)) {
      list.push(w);
    }
  }
  for (const p of Object.values(store.projects || {})) {
    for (const w of p.wallets || []) {
      if (w.address && (w.private_key || w.privateKey)) list.push(w);
    }
  }
  for (const h of store.hopVault || []) {
    if (h.address && (h.privateKey || h.private_key)) list.push(h);
  }
  const idx = loadKeyIndex();
  for (const w of list) {
    idx.addresses[normAddr(w.address)] = {
      sourceFile: "dashboard-store",
      registeredAt: new Date().toISOString(),
      name: w.name || null,
    };
  }
  saveKeyIndex(idx);
  return list.length;
}

module.exports = {
  get LEGS_DIR() {
    return LEGS_DIR();
  },
  get KEY_INDEX() {
    return KEY_INDEX();
  },
  persistLegsBeforePay,
  assertCanSendTo,
  assertLegsReadyForPay,
  registerControlledAddress,
  isAddressControlled,
  registerStoreWallets,
  loadKeyIndex,
};
