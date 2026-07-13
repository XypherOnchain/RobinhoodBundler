require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const TelegramBot = require("node-telegram-bot-api");
const chain = require("./blockchain");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
    console.error("Missing TELEGRAM_BOT_TOKEN in .env");
    process.exit(1);
}

const ALLOWED = (process.env.ALLOWED_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const DATA_DIR = path.join(__dirname, "data");
const WALLETS_FILE = path.join(DATA_DIR, "wallets.json");
const EXPLORER = "https://robinhoodchain.blockscout.com";
const NOXA = "https://fun.noxa.fi/robinhood";

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadWallets() {
    try {
        return JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8"));
    } catch {
        return {};
    }
}
function saveWallets(data) {
    fs.writeFileSync(WALLETS_FILE, JSON.stringify(data, null, 2));
}

let walletsByUser = loadWallets();
const userState = {};
const lastPlan = {};
const lastToken = {};
const busy = {};

const bot = new TelegramBot(TOKEN, { polling: true });
console.log("NOXA Robinhood bot started...");

function ok(msg) {
    if (ALLOWED.length === 0) return true;
    return ALLOWED.includes(String(msg.from?.id));
}
function wallets(chatId) {
    if (!walletsByUser[chatId]) walletsByUser[chatId] = [];
    return walletsByUser[chatId];
}
function funder(chatId) {
    return wallets(chatId).find((w) => w.role === "funder") || null;
}
function buyers(chatId) {
    return wallets(chatId).filter((w) => w.role !== "funder");
}
function esc(s) {
    return String(s ?? "").replace(/([_*`\[\]])/g, "\\$1");
}

function mainKb() {
    return {
        inline_keyboard: [
            [{ text: "📋 Plan a buy", callback_data: "plan" }],
            [
                { text: "👛 Wallets", callback_data: "wallets" },
                { text: "💸 Fund wallets", callback_data: "fund" },
            ],
            [
                { text: "🛒 Run buys", callback_data: "runbuys" },
                { text: "❓ Help", callback_data: "help" },
            ],
        ],
    };
}

async function showHome(chatId, messageId) {
    const f = funder(chatId);
    const b = buyers(chatId);
    const ready = b.filter((w) => Number(w.buyAmountEth) > 0).length;
    const text =
        `*NOXA Buy Bot*\n` +
        `_Robinhood · fun.noxa.fi_\n\n` +
        `Funder: ${f ? `\`${chain.shortenAddress(f.address)}\`` : "_not set_"}\n` +
        `Buyers: \`${b.length}\` · ready: \`${ready}\`\n\n` +
        `*Simple flow*\n` +
        `1. Add wallets\n` +
        `2. Plan a buy (see amounts + tokens)\n` +
        `3. Fund wallets\n` +
        `4. Run buys\n\n` +
        `Or paste a token address anytime.`;
    const opts = {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: mainKb(),
    };
    if (messageId) {
        try {
            return await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                ...opts,
            });
        } catch (_) {}
    }
    return bot.sendMessage(chatId, text, opts);
}

function formatPlan(plan) {
    const t = plan.token;
    let msg =
        `*Buy plan — $${esc(t.symbol)}*\n` +
        `\`${t.address}\`\n\n` +
        `Supply: \`${chain.formatTokenAmount(t.supply)}\`\n` +
        `Now: \`${Number(t.mcapEth).toFixed(3)}\` ETH MC` +
        (t.priceEth ? ` · \`${Number(t.priceEth).toExponential(3)}\` ETH/token` : "") +
        `\n` +
        `Launch start: ~\`${t.startingMcEth}\` ETH MC\n` +
        `Max wallet: \`${t.maxWalletPct}%\` (~${chain.formatTokenAmount(t.maxWalletTokens)} tokens)\n\n` +
        `Budget: \`${plan.totalEth}\` ETH · \`${plan.walletCount}\` wallets\n` +
        `_First buys least → last buys most_\n\n`;

    plan.rows.forEach((r) => {
        const warn = r.overMax ? " ⚠️ over max wallet" : "";
        msg +=
            `*#${r.index}*  \`${r.eth}\` ETH` +
            ` → ~\`${chain.formatTokenAmount(r.tokensEst)}\` ` +
            `(\`${r.pctSupply.toFixed(3)}%\`)${warn}\n` +
            `   wait \`${r.delaySec}s\` before this buy\n`;
    });

    msg +=
        `\n*Total* ~\`${chain.formatTokenAmount(plan.totalTokensEst)}\` tokens` +
        ` (\`${plan.totalPctSupply.toFixed(3)}%\` of supply)\n` +
        `_Estimates use live price; actual fill moves with each buy._`;
    return msg;
}

function planKb(hasPlan) {
    const rows = [];
    if (hasPlan) {
        rows.push([{ text: "✅ Apply to my wallets", callback_data: "plan_apply" }]);
        rows.push([
            { text: "💸 Fund wallets", callback_data: "fund" },
            { text: "🛒 Run buys", callback_data: "runbuys" },
        ]);
    }
    rows.push([
        { text: "🔄 New plan", callback_data: "plan" },
        { text: "🏠 Home", callback_data: "home" },
    ]);
    return { inline_keyboard: rows };
}

function walletsKb(chatId) {
    const list = wallets(chatId);
    const rows = list.map((w, i) => {
        const tag = w.role === "funder" ? "Funder" : `Buyer`;
        const amt =
            w.role === "funder"
                ? ""
                : w.buyAmountEth != null
                  ? ` · ${w.buyAmountEth}Ξ`
                  : " · no amount";
        return [
            {
                text: `${tag}${amt} · ${chain.shortenAddress(w.address)}`,
                callback_data: `w_${i}`,
            },
        ];
    });
    rows.push([
        { text: "➕ Add funder", callback_data: "add_funder" },
        { text: "➕ Add buyer", callback_data: "add_buyer" },
    ]);
    rows.push([
        { text: "➕ Make 5 buyers", callback_data: "make5" },
        { text: "🏠 Home", callback_data: "home" },
    ]);
    return { inline_keyboard: rows };
}

function walletKb(i) {
    return {
        inline_keyboard: [
            [
                { text: "💵 Amount", callback_data: `amt_${i}` },
                { text: "⏱ Delay", callback_data: `dly_${i}` },
            ],
            [
                { text: "Make funder", callback_data: `makefunder_${i}` },
                { text: "🗑 Remove", callback_data: `rm_${i}` },
            ],
            [
                { text: "🔑 PK", callback_data: `pk_${i}` },
                { text: "← Back", callback_data: "wallets" },
            ],
        ],
    };
}

async function showTokenCard(chatId, tokenAddress, messageId) {
    lastToken[chatId] = tokenAddress;
    const info = await chain.getTokenInfo(tokenAddress);
    const t = info.token || info;
    let supply = chain.NOXA_DEFAULT_SUPPLY;
    try {
        supply = Number(
            ethers.formatUnits(t.supply || t.totalSupply || "0", t.decimals ?? 18)
        );
    } catch (_) {}

    const mcap = Number(t.marketCapEth || 0);
    const price = Number(t.priceEth || 0);
    const text =
        `*$${esc(t.symbol)}* — ${esc(t.name)}\n` +
        `\`${t.address || tokenAddress}\`\n\n` +
        `Supply: \`${chain.formatTokenAmount(supply)}\` _(NOXA default 1B)_\n` +
        `MC now: \`${mcap.toFixed(3)}\` ETH\n` +
        `Start MC: ~\`${chain.NOXA_STARTING_MC_ETH}\` ETH\n` +
        `Price: \`${price ? price.toExponential(3) : "?"}\` ETH\n` +
        `Max wallet: \`2%\`\n\n` +
        `[NOXA](${NOXA}/${t.address || tokenAddress})`;

    const kb = {
        inline_keyboard: [
            [
                {
                    text: "📋 Plan buys for this",
                    callback_data: `plan_tok_${tokenAddress}`,
                },
            ],
            [{ text: "🏠 Home", callback_data: "home" }],
        ],
    };
    const opts = {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: kb,
    };
    if (messageId) {
        try {
            return await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                ...opts,
            });
        } catch (_) {}
    }
    return bot.sendMessage(chatId, text, opts);
}

async function startPlanWizard(chatId, tokenAddress) {
    if (!tokenAddress) {
        userState[chatId] = { action: "plan_token" };
        return bot.sendMessage(chatId, "Paste the token address to plan buys for:");
    }
    lastToken[chatId] = tokenAddress;
    userState[chatId] = { action: "plan_budget", token: tokenAddress };
    return bot.sendMessage(
        chatId,
        `Planning buys for \`${tokenAddress}\`\n\n` +
            `Send: \`totalETH wallets\`\n` +
            `Example: \`0.2 4\`\n` +
            `→ splits 0.2 ETH across 4 wallets\n` +
            `(#1 buys least, last buys most)\n\n` +
            `You have \`${buyers(chatId).length}\` buyer wallets.`,
        { parse_mode: "Markdown" }
    );
}

async function buildAndShowPlan(chatId, token, totalEth, walletCount) {
    const status = await bot.sendMessage(chatId, "Building plan…");
    try {
        const plan = await chain.buildBuyPlan(token, totalEth, walletCount, {
            baseDelaySec: 15,
            useQuoter: true,
        });
        lastPlan[chatId] = plan;
        lastToken[chatId] = token;
        await bot.editMessageText(formatPlan(plan), {
            chat_id: chatId,
            message_id: status.message_id,
            parse_mode: "Markdown",
            reply_markup: planKb(true),
        });
    } catch (e) {
        await bot.editMessageText(`Plan failed: ${e.message}`, {
            chat_id: chatId,
            message_id: status.message_id,
        });
    }
}

function applyPlanToWallets(chatId, plan) {
    const list = wallets(chatId);
    let b = buyers(chatId);

    while (b.length < plan.walletCount) {
        const w = chain.generateWallet();
        list.push({
            name: `Buyer ${b.length + 1}`,
            address: w.address,
            private_key: w.privateKey,
            role: "buyer",
            isDefault: list.length === 0,
            buyAmountEth: null,
            delaySec: 0,
        });
        b = buyers(chatId);
    }

    b.slice(0, plan.walletCount).forEach((w, i) => {
        w.buyAmountEth = plan.rows[i].eth;
        w.delaySec = plan.rows[i].delaySec;
        w.name = `Buyer ${i + 1}`;
    });
    b.slice(plan.walletCount).forEach((w) => {
        w.buyAmountEth = null;
    });
    saveWallets(walletsByUser);
    return buyers(chatId).slice(0, plan.walletCount);
}

bot.onText(/\/start/, async (msg) => {
    if (!ok(msg)) return bot.sendMessage(msg.chat.id, "Unauthorized.");
    await showHome(msg.chat.id);
});

bot.onText(/\/help/, async (msg) => {
    if (!ok(msg)) return;
    await bot.sendMessage(
        msg.chat.id,
        `*How it works*\n\n` +
            `NOXA tokens on Robinhood usually have:\n` +
            `• Supply: *1 billion*\n` +
            `• Starting MC: *~1.36 ETH*\n` +
            `• Max wallet: *2%*\n\n` +
            `*Plan a buy* splits your budget so wallet #1 buys the least and the last wallet buys the most — and shows estimated tokens + % of supply.\n\n` +
            `*Fund wallets* sends ETH through temporary hop wallets so buyers aren’t all linked directly to your funder.\n\n` +
            `*Run buys* executes each wallet in order with its delay.`,
        { parse_mode: "Markdown" }
    );
});

bot.on("callback_query", async (q) => {
    const chatId = q.message.chat.id;
    const mid = q.message.message_id;
    const data = q.data;
    if (!ok({ from: q.from })) {
        return bot.answerCallbackQuery(q.id, { text: "Unauthorized" });
    }
    await bot.answerCallbackQuery(q.id);

    try {
        if (data === "home") return showHome(chatId, mid);
        if (data === "help") {
            await bot.sendMessage(
                chatId,
                "Plan → see who buys what → Fund → Run buys. Paste a token anytime."
            );
            return showHome(chatId, mid);
        }

        if (data === "plan") {
            return startPlanWizard(chatId, lastToken[chatId] || null);
        }
        if (data.startsWith("plan_tok_")) {
            return startPlanWizard(chatId, data.slice("plan_tok_".length));
        }

        if (data === "plan_apply") {
            const plan = lastPlan[chatId];
            if (!plan) return bot.sendMessage(chatId, "No plan. Tap Plan a buy.");
            const applied = applyPlanToWallets(chatId, plan);
            return bot.sendMessage(
                chatId,
                `✅ Applied to ${applied.length} wallets:\n` +
                    applied
                        .map(
                            (w, i) =>
                                `${i + 1}. \`${w.buyAmountEth}\` ETH · ${w.delaySec}s · ${chain.shortenAddress(w.address)}`
                        )
                        .join("\n"),
                {
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: "💸 Fund wallets", callback_data: "fund" },
                                { text: "🛒 Run buys", callback_data: "runbuys" },
                            ],
                            [{ text: "🏠 Home", callback_data: "home" }],
                        ],
                    },
                }
            );
        }

        if (data === "wallets") {
            const f = funder(chatId);
            const b = buyers(chatId);
            return bot.editMessageText(
                `*Wallets*\n\nFunder: ${f ? "set ✅" : "missing ❌"}\nBuyers: ${b.length}\n\nTap a wallet to edit.`,
                {
                    chat_id: chatId,
                    message_id: mid,
                    parse_mode: "Markdown",
                    reply_markup: walletsKb(chatId),
                }
            );
        }

        if (data === "add_funder" || data === "add_buyer") {
            userState[chatId] = {
                action: "import_pk",
                role: data === "add_funder" ? "funder" : "buyer",
            };
            return bot.sendMessage(
                chatId,
                data === "add_funder"
                    ? "Send funder private key:"
                    : "Send buyer private key (or use Make 5 buyers):"
            );
        }

        if (data === "make5") {
            const list = wallets(chatId);
            const addrs = [];
            for (let i = 0; i < 5; i++) {
                const w = chain.generateWallet();
                const n = buyers(chatId).length + 1;
                list.push({
                    name: `Buyer ${n}`,
                    address: w.address,
                    private_key: w.privateKey,
                    role: "buyer",
                    isDefault: false,
                    buyAmountEth: null,
                    delaySec: 15 * i,
                });
                addrs.push(w.address);
            }
            saveWallets(walletsByUser);
            return bot.sendMessage(
                chatId,
                `✅ 5 buyers ready:\n` + addrs.map((a) => `\`${a}\``).join("\n"),
                { parse_mode: "Markdown", reply_markup: walletsKb(chatId) }
            );
        }

        if (data.startsWith("w_")) {
            const i = Number(data.slice(2));
            const w = wallets(chatId)[i];
            if (!w) return;
            let bal = "?";
            try {
                bal = await chain.getWalletBalance(w.address);
            } catch (_) {}
            return bot.editMessageText(
                `*${esc(w.name)}* (${w.role || "buyer"})\n` +
                    `\`${w.address}\`\n\n` +
                    `Balance: \`${bal}\` ETH\n` +
                    `Buy: \`${w.buyAmountEth ?? "—"}\` ETH\n` +
                    `Delay: \`${w.delaySec ?? 0}s\``,
                {
                    chat_id: chatId,
                    message_id: mid,
                    parse_mode: "Markdown",
                    reply_markup: walletKb(i),
                }
            );
        }

        if (data.startsWith("amt_")) {
            const i = Number(data.slice(4));
            userState[chatId] = { action: "set_amt", index: i };
            return bot.sendMessage(chatId, "ETH amount for this wallet (e.g. 0.04):");
        }
        if (data.startsWith("dly_")) {
            const i = Number(data.slice(4));
            userState[chatId] = { action: "set_dly", index: i };
            return bot.sendMessage(chatId, "Delay in seconds before this wallet buys:");
        }
        if (data.startsWith("makefunder_")) {
            const i = Number(data.slice(11));
            wallets(chatId).forEach((w, idx) => {
                w.role =
                    idx === i
                        ? "funder"
                        : w.role === "funder"
                          ? "buyer"
                          : w.role || "buyer";
            });
            saveWallets(walletsByUser);
            return bot.sendMessage(chatId, "💰 Set as funder.");
        }
        if (data.startsWith("rm_")) {
            const i = Number(data.slice(3));
            const removed = wallets(chatId).splice(i, 1)[0];
            saveWallets(walletsByUser);
            return bot.sendMessage(chatId, `Removed ${removed?.name || ""}`, {
                reply_markup: walletsKb(chatId),
            });
        }
        if (data.startsWith("pk_")) {
            const i = Number(data.slice(3));
            const w = wallets(chatId)[i];
            return bot.sendMessage(
                chatId,
                `⚠️ \`${w.private_key}\`\nDelete this message after saving.`,
                { parse_mode: "Markdown" }
            );
        }

        if (data === "fund") return runFund(chatId, 2);

        if (data === "runbuys") {
            const tok = lastToken[chatId] || lastPlan[chatId]?.token?.address;
            if (!tok) {
                userState[chatId] = { action: "runbuys_token" };
                return bot.sendMessage(chatId, "Paste token address to buy:");
            }
            return runBuys(chatId, tok);
        }
    } catch (e) {
        console.error(e);
        await bot.sendMessage(chatId, `Error: ${e.message}`);
    }
});

bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    if (!ok(msg)) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const st = userState[chatId];

    try {
        if (st?.action === "import_pk") {
            const role = st.role || "buyer";
            delete userState[chatId];
            if (!chain.isEvmPrivateKey(text)) {
                return bot.sendMessage(chatId, "Invalid key.");
            }
            const w = chain.generateWallet(
                text.startsWith("0x") ? text : `0x${text}`
            );
            const list = wallets(chatId);
            if (list.some((x) => x.address.toLowerCase() === w.address.toLowerCase())) {
                return bot.sendMessage(chatId, "Already added.");
            }
            if (role === "funder") {
                list.forEach((x) => {
                    if (x.role === "funder") x.role = "buyer";
                });
            }
            list.push({
                name:
                    role === "funder"
                        ? "Funder"
                        : `Buyer ${buyers(chatId).length + 1}`,
                address: w.address,
                private_key: w.privateKey,
                role,
                isDefault: list.length === 0,
                buyAmountEth: null,
                delaySec: role === "funder" ? 0 : 15,
            });
            saveWallets(walletsByUser);
            return bot.sendMessage(
                chatId,
                `✅ ${role} added\n\`${w.address}\``,
                { parse_mode: "Markdown", reply_markup: walletsKb(chatId) }
            );
        }

        if (st?.action === "plan_token") {
            delete userState[chatId];
            if (!chain.isEvmAddress(text)) {
                return bot.sendMessage(chatId, "Invalid address.");
            }
            return startPlanWizard(chatId, text);
        }

        if (st?.action === "plan_budget") {
            const token = st.token;
            delete userState[chatId];
            const parts = text.split(/[\s,]+/).filter(Boolean);
            const totalEth = Number(parts[0]);
            const count = Number(parts[1] || Math.max(buyers(chatId).length, 3));
            if (
                !Number.isFinite(totalEth) ||
                totalEth <= 0 ||
                !Number.isFinite(count) ||
                count < 1
            ) {
                return bot.sendMessage(chatId, "Send like: `0.2 4`", {
                    parse_mode: "Markdown",
                });
            }
            return buildAndShowPlan(chatId, token, totalEth, count);
        }

        if (st?.action === "set_amt") {
            const i = st.index;
            delete userState[chatId];
            const amt = Number(text);
            if (!Number.isFinite(amt) || amt < 0) {
                return bot.sendMessage(chatId, "Invalid amount.");
            }
            wallets(chatId)[i].buyAmountEth = amt;
            saveWallets(walletsByUser);
            return bot.sendMessage(chatId, `✅ Amount set to ${amt} ETH`);
        }

        if (st?.action === "set_dly") {
            const i = st.index;
            delete userState[chatId];
            const sec = Number(text);
            if (!Number.isFinite(sec) || sec < 0) {
                return bot.sendMessage(chatId, "Invalid delay.");
            }
            wallets(chatId)[i].delaySec = sec;
            saveWallets(walletsByUser);
            return bot.sendMessage(chatId, `✅ Delay set to ${sec}s`);
        }

        if (st?.action === "runbuys_token") {
            delete userState[chatId];
            if (!chain.isEvmAddress(text)) {
                return bot.sendMessage(chatId, "Invalid address.");
            }
            return runBuys(chatId, text);
        }

        if (chain.isEvmAddress(text)) {
            await bot.sendMessage(chatId, "Loading…");
            return showTokenCard(chatId, text);
        }
    } catch (e) {
        console.error(e);
        await bot.sendMessage(chatId, `Error: ${e.message}`);
    }
});

async function runFund(chatId, hops) {
    if (busy[chatId]) {
        return bot.sendMessage(chatId, "Busy — wait for the current job.");
    }
    const f = funder(chatId);
    if (!f) return bot.sendMessage(chatId, "Add a funder wallet first.");
    const dest = buyers(chatId).filter((w) => Number(w.buyAmountEth) > 0);
    if (!dest.length) {
        return bot.sendMessage(
            chatId,
            "No buyer amounts set. Use *Plan a buy* first.",
            { parse_mode: "Markdown" }
        );
    }

    busy[chatId] = true;
    await bot.sendMessage(
        chatId,
        `💸 Funding ${dest.length} wallets via ${hops} hops…\n(takes a few minutes)`
    );

    try {
        await chain.disperseWithHops(
            { private_key: f.private_key },
            dest.map((w) => ({
                address: w.address,
                amountEth: w.buyAmountEth,
                name: w.name,
            })),
            {
                hops,
                onProgress: async (ev) => {
                    if (ev.type === "done") {
                        await bot.sendMessage(
                            chatId,
                            `✅ ${ev.name} funded\n[tx](${EXPLORER}/tx/${ev.hash})`,
                            {
                                parse_mode: "Markdown",
                                disable_web_page_preview: true,
                            }
                        );
                    }
                },
            }
        );
        await bot.sendMessage(chatId, "✅ Funding done. You can Run buys now.", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🛒 Run buys", callback_data: "runbuys" }],
                    [{ text: "🏠 Home", callback_data: "home" }],
                ],
            },
        });
    } catch (e) {
        await bot.sendMessage(
            chatId,
            `Funding failed: ${e.shortMessage || e.message}`
        );
    } finally {
        busy[chatId] = false;
    }
}

async function runBuys(chatId, tokenAddress) {
    if (busy[chatId]) {
        return bot.sendMessage(chatId, "Busy — wait for the current job.");
    }
    const list = buyers(chatId).filter((w) => Number(w.buyAmountEth) > 0);
    if (!list.length) {
        return bot.sendMessage(chatId, "No buyer amounts. Plan a buy first.");
    }

    lastToken[chatId] = tokenAddress;
    busy[chatId] = true;

    const summary = list
        .map(
            (w, i) =>
                `${i + 1}. ${w.buyAmountEth} ETH · wait ${w.delaySec ?? 0}s · ${chain.shortenAddress(w.address)}`
        )
        .join("\n");
    await bot.sendMessage(
        chatId,
        `🛒 Running buys\n\`${tokenAddress}\`\n\n${summary}`,
        { parse_mode: "Markdown" }
    );

    try {
        const results = await chain.multiBuy(
            list.map((w) => ({
                private_key: w.private_key,
                address: w.address,
                name: w.name,
                buyAmountEth: w.buyAmountEth,
                delaySec: w.delaySec ?? 0,
            })),
            tokenAddress,
            {
                onProgress: async (ev) => {
                    if (ev.type === "waiting") {
                        await bot.sendMessage(
                            chatId,
                            `⏳ ${ev.delaySec}s until next wallet…`
                        );
                    } else if (ev.type === "bought") {
                        await bot.sendMessage(
                            chatId,
                            `✅ ${ev.amountEth} ETH\n[tx](${EXPLORER}/tx/${ev.hash})`,
                            {
                                parse_mode: "Markdown",
                                disable_web_page_preview: true,
                            }
                        );
                    } else if (ev.type === "error") {
                        await bot.sendMessage(
                            chatId,
                            `❌ ${ev.wallet}: ${ev.error}`
                        );
                    }
                },
            }
        );
        const okN = results.filter((r) => r.hash).length;
        await bot.sendMessage(
            chatId,
            `Done. ${okN}/${list.length} buys submitted.`
        );
    } catch (e) {
        await bot.sendMessage(chatId, `Buys failed: ${e.message}`);
    } finally {
        busy[chatId] = false;
    }
}

bot.on("polling_error", (err) => console.error("polling_error:", err.message));
