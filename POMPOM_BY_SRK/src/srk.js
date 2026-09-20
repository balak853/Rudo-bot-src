// index.js - Complete Telegram Bot with Payment Verification, Admin Panel,
// Welcome Image, Broadcast, Plan Management + CUSTOM QR SUPPORT
// v7.1.1 — FIXED /admin COMMAND + CUSTOM QR
//
// FIX in v7.1.1:
//   - /admin command keyboard ab "Set UPI / QR" dikhata hai (pehle "Set UPI ID" tha)
//   - QR Mode label ab /admin command mein bhi visible hai
//   - Naya admin bhi Custom QR option dekh sakta hai
//
// Features:
//   - Manual payment verification
//   - New user notification with profile link
//   - Welcome image + welcome message + plan buttons (single message)
//   - Plan buttons: ONE PER ROW
//   - Admin broadcast to all users (batched, rate-limited)
//   - Plan add/edit/delete
//   - Demo videos (batch support)
//   - Group link per plan
//   - CUSTOM QR + AUTO QR system
//
// High-Traffic Optimizations:
//   - In-memory state with TTL cleanup
//   - Debounced disk writes
//   - Batched broadcast with rate-limit protection
//   - Graceful shutdown with state flush
//   - Circuit breaker for API calls
//   - Connection pooling for HTTP
//   - Memory leak prevention
//   - Safe handler wrapper for every action
//   - Global error boundaries
//   - Retry logic with exponential backoff
//   - Health check endpoint (optional)

const { Telegraf, Markup } = require("telegraf");
const QRCode = require("qrcode");
const http = require("http");
const cfg    = require("../config");
const {
  loadData, getData, updateData,
  trackUser, addPayment, updatePaymentStatus, getStats,
  updatePlan, deletePlan, getPlan, addPlan
} = require("./store");

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const PERF = {
    STATE_TTL_MS: 30 * 60 * 1000,
    STATE_CLEANUP_MS: 60 * 1000,
    BROADCAST_BATCH_SIZE: 25,
    BROADCAST_BATCH_DELAY_MS: 1100,
    BROADCAST_MAX_CONCURRENT: 5,
    MAX_STATE_ENTRIES: 100000
};

// ═══════════════════════════════════════════════════════════════════════════
// BOT SETUP
// ═══════════════════════════════════════════════════════════════════════════

const bot = new Telegraf(cfg.BOT_TOKEN, {
    handlerTimeout: 90000
});

// ═══════════════════════════════════════════════════════════════════════════
// STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════

const userStates = new Map();

function getState(id) {
    const entry = userStates.get(id);
    if (!entry) return { type: "idle" };
    if (Date.now() - entry._ts > PERF.STATE_TTL_MS) {
        userStates.delete(id);
        return { type: "idle" };
    }
    return entry;
}

function setState(id, state) {
    if (userStates.size > PERF.MAX_STATE_ENTRIES) {
        const entries = [...userStates.entries()]
            .sort((a, b) => (a[1]._ts || 0) - (b[1]._ts || 0));
        const toRemove = Math.floor(entries.length * 0.1);
        for (let i = 0; i < toRemove; i++) userStates.delete(entries[i][0]);
    }
    userStates.set(id, { ...state, _ts: Date.now() });
}

function clearState(id) {
    userStates.set(id, { type: "idle", _ts: Date.now() });
}

function isAdmin(chatId) {
    return String(chatId) === String(getData().adminChatId);
}

setInterval(() => {
    const now = Date.now();
    let removed = 0;
    for (const [id, state] of userStates.entries()) {
        if (now - (state._ts || 0) > PERF.STATE_TTL_MS) {
            userStates.delete(id);
            removed++;
        }
    }
    if (removed > 0) {
        console.log(`🧹 State cleanup: removed ${removed} expired entries (total: ${userStates.size})`);
    }
}, PERF.STATE_CLEANUP_MS);

let orderCounter = 5000;

// ═══════════════════════════════════════════════════════════════════════════
// SAFE HANDLER WRAPPER
// ═══════════════════════════════════════════════════════════════════════════

function safeHandler(fn) {
    return async (ctx, next) => {
        try {
            await fn(ctx, next);
        } catch (err) {
            const code = err?.response?.error_code;
            const desc = err?.response?.description || "";
            if (code === 403) return;
            if (code === 400 && desc.includes("query is too old")) return;
            if (code === 429) {
                console.error("⚠️ Rate limited by Telegram:", desc);
                return;
            }
            console.error("❌ Handler error:", err.message || err);
            if (err.stack) console.error(err.stack);
            try {
                await ctx.reply("⚠️ Something went wrong. Please try /start again.");
            } catch {}
        }
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// QR MODE HELPERS (CUSTOM QR SYSTEM)
// ═══════════════════════════════════════════════════════════════════════════

function getQrMode() {
    const data = getData();
    return data.qrMode || "auto";
}

function setQrMode(mode) {
    updateData({ qrMode: mode });
}

function getCustomQrImageId() {
    const data = getData();
    return data.customQrImageId || null;
}

function setCustomQrImageId(fileId) {
    updateData({ customQrImageId: fileId });
}

// ═══════════════════════════════════════════════════════════════════════════
// UPI QR GENERATOR (auto mode with caching)
// ═══════════════════════════════════════════════════════════════════════════

const qrCache = new Map();
const QR_CACHE_TTL = 10 * 60 * 1000;

async function generateUpiQr(upiId, upiName, amount) {
    const cacheKey = `${upiId}|${upiName}|${amount}`;
    const cached = qrCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < QR_CACHE_TTL) {
        return cached.buffer;
    }

    const url = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(upiName || "Merchant")}&am=${amount}&cu=INR&tn=${encodeURIComponent("Subscription Purchase")}`;

    const buffer = await QRCode.toBuffer(url, {
        errorCorrectionLevel: "H",
        width: 400,
        margin: 2
    });

    qrCache.set(cacheKey, { buffer, ts: Date.now() });

    if (qrCache.size > 500) {
        const entries = [...qrCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
        for (let i = 0; i < 100; i++) qrCache.delete(entries[i][0]);
    }

    return buffer;
}

// ═══════════════════════════════════════════════════════════════════════════
// KEYBOARDS
// ═══════════════════════════════════════════════════════════════════════════

function planKeyboard(plans) {
    const btns = [];
    for (const p of plans) {
        btns.push([Markup.button.callback(`📦 ${p.name} — ₹${p.price} / ${p.days} days`, `plan:${p.id}`)]);
    }
    btns.push([
        Markup.button.callback("📖 How to Use", "howto"),
        Markup.button.callback("🆘 Report Issue", "report")
    ]);
    return Markup.inlineKeyboard(btns);
}

function welcomeKeyboard(plans) {
    const btns = [];
    for (const p of plans) {
        btns.push([Markup.button.callback(`📦 ${p.name} — ₹${p.price}`, `plan:${p.id}`)]);
    }
    btns.push([
        Markup.button.callback("📖 How to Use", "howto"),
        Markup.button.callback("🆘 Report Issue", "report")
    ]);
    return Markup.inlineKeyboard(btns);
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED ADMIN PANEL KEYBOARD (single source of truth)
// ═══════════════════════════════════════════════════════════════════════════

function buildAdminPanelKeyboard() {
    const qrModeLabel = getQrMode() === "custom" ? "🖼️ Custom QR" : "⚡ Auto QR";

    const text =
        "🔧 *Admin Panel*\n\n" +
        `💳 QR Mode: *${qrModeLabel}*\n\n` +
        "Choose an option:";

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("📊 Bot Stats", "admin_stats")],
        [Markup.button.callback("💰 Recent Payments", "admin_recent_payments")],
        [Markup.button.callback("📢 Broadcast Message", "admin_broadcast")],
        [Markup.button.callback("📋 View Plans", "admin_view_plans"), Markup.button.callback("➕ Add Plan", "admin_add_plan")],
        [Markup.button.callback("💳 Set UPI / QR", "admin_set_upi")],
        [Markup.button.callback("🖼️ Set Welcome Image", "admin_set_welcome_image"), Markup.button.callback("🗑️ Remove Image", "admin_remove_welcome_image")],
        [Markup.button.callback("🎬 Add Welcome Video", "admin_add_video"), Markup.button.callback("🗑️ Remove Video", "admin_remove_video")],
        [Markup.button.callback("✏️ Set Welcome Message", "admin_set_welcome")],
        [Markup.button.callback("👤 Change Admin Chat ID", "admin_set_admin_id")],
    ]);

    return { text, keyboard };
}

// ═══════════════════════════════════════════════════════════════════════════
// NEW USER NOTIFICATION
// ═══════════════════════════════════════════════════════════════════════════

async function notifyAdminNewUser(ctx) {
    try {
        const data = getData();
        const u = ctx.from;
        const fullName = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || "Unknown";
        const username = u.username ? `@${u.username}` : "_No username_";
        const lang = u.language_code || "unknown";
        const joinTime = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

        const freshData = getData();
        let totalUsers = "?";
        if (freshData.users) {
            totalUsers = Array.isArray(freshData.users)
                ? freshData.users.length
                : Object.keys(freshData.users).length;
        }

        const notifMsg =
            `🆕 *New User Joined!*\n\n` +
            `👤 *Name:* ${fullName}\n` +
            `🔗 *Profile:* [Open Profile](tg://user?id=${u.id})\n` +
            `📛 *Username:* ${username}\n` +
            `🆔 *Chat ID:* \`${u.id}\`\n` +
            `🌐 *Language:* \`${lang}\`\n` +
            `🕒 *Joined:* ${joinTime}\n\n` +
            `👥 *Total Users:* ${totalUsers}`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.url("👤 Open Profile", `tg://user?id=${u.id}`)],
            [Markup.button.url("💬 Send Message", `tg://user?id=${u.id}`)]
        ]);

        await bot.telegram.sendMessage(data.adminChatId, notifMsg, {
            parse_mode: "Markdown",
            ...keyboard
        });
    } catch (notifErr) {
        if (notifErr?.response?.error_code !== 403) {
            console.error("New user notification error:", notifErr.message);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SEND WELCOME
// ═══════════════════════════════════════════════════════════════════════════

async function sendWelcome(ctx, data) {
    const welcomeText = data.welcomeMessage || "👋 Welcome!";
    const keyboard = welcomeKeyboard(data.plans || []);

    if (data.welcomeImageId) {
        try {
            await ctx.replyWithPhoto(data.welcomeImageId, {
                caption: welcomeText,
                parse_mode: "Markdown",
                ...keyboard
            });
            return;
        } catch (e) {
            if (e?.response?.error_code !== 403) {
                console.error("Welcome image send error:", e.message);
            }
        }
    }

    try {
        await ctx.replyWithMarkdown(welcomeText, keyboard);
    } catch (e) {
        if (e?.response?.error_code !== 403) {
            console.error("Welcome msg error:", e.message);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SEND PAYMENT QR (handles both auto and custom mode)
// ═══════════════════════════════════════════════════════════════════════════

async function sendPaymentQr(ctx, plan, data) {
    const caption =
        `💳 *Payment Details*\n\n` +
        `📦 Plan: *${plan.name}*\n` +
        `💰 Amount: ₹${plan.price}\n` +
        `⏳ Validity: ${plan.days} Days\n\n` +
        `🆔 UPI ID: \`${data.upiId || "N/A"}\`\n` +
        `👤 Name: ${data.upiName || "Merchant"}`;

    const mode = getQrMode();

    // CUSTOM QR MODE
    if (mode === "custom") {
        const customQrId = getCustomQrImageId();
        if (customQrId) {
            try {
                await ctx.replyWithPhoto(customQrId, {
                    caption,
                    parse_mode: "Markdown"
                });
                return;
            } catch (e) {
                console.error("Custom QR send failed, falling back to auto:", e.message);
            }
        }
    }

    // AUTO QR MODE (default / fallback)
    try {
        const qrBuf = await generateUpiQr(data.upiId, data.upiName || "Merchant", plan.price);
        await ctx.replyWithPhoto(
            { source: qrBuf, filename: "payment_qr.png" },
            {
                caption,
                parse_mode: "Markdown",
            }
        );
    } catch (e) {
        console.error("QR error:", e.message);
        await ctx.replyWithMarkdown(
            `💳 *Payment Details*\n\n` +
            `📦 Plan: *${plan.name}*\n` +
            `💰 Amount: ₹${plan.price}\n` +
            `⏳ Validity: ${plan.days} Days\n\n` +
            `🆔 UPI ID: \`${data.upiId}\`\n` +
            `👤 Name: ${data.upiName || "Merchant"}\n\n` +
            `_(QR unavailable — pay manually to above UPI)_`
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// /start COMMAND
// ═══════════════════════════════════════════════════════════════════════════

bot.start(safeHandler(async (ctx) => {
    const data = getData();
    clearState(ctx.from.id);

    const userIdStr = String(ctx.from.id);
    let isNewUser = false;

    if (data.users) {
        if (Array.isArray(data.users)) {
            isNewUser = !data.users.some(u => String(u.id ?? u.chatId ?? u.userId) === userIdStr);
        } else if (typeof data.users === "object") {
            isNewUser = !data.users[userIdStr];
        }
    } else {
        isNewUser = true;
    }

    trackUser(ctx.from);

    if (isNewUser) {
        notifyAdminNewUser(ctx).catch(() => {});
    }

    await sendWelcome(ctx, data);

    for (const vid of data.welcomeVideoIds || []) {
        try { await ctx.replyWithVideo(vid); } catch {}
    }
}));

// ═══════════════════════════════════════════════════════════════════════════
// BACK TO PLANS
// ═══════════════════════════════════════════════════════════════════════════

bot.action("back_to_plans", safeHandler(async (ctx) => {
    await ctx.answerCbQuery();
    const data = getData();
    await sendWelcome(ctx, data);
}));

// ═══════════════════════════════════════════════════════════════════════════
// PLAN SELECTION
// ═══════════════════════════════════════════════════════════════════════════

bot.action(/^plan:(.+)$/, safeHandler(async (ctx) => {
    await ctx.answerCbQuery();
    const plan = getData().plans.find(p => p.id === ctx.match[1]);
    if (!plan) { await ctx.reply("❌ Plan not found."); return; }

    const demoVideos = Array.isArray(plan.demoVideos) ? plan.demoVideos : [];

    if (demoVideos.length > 0) {
        await ctx.reply(`🎬 *${plan.name} - Demo Videos*\n\nShowing ${demoVideos.length} preview videos:`, { parse_mode: "Markdown" });

        try {
            const mediaGroup = demoVideos.map((videoId, index) => ({
                type: 'video',
                media: videoId,
                caption: index === 0 ? `🎬 *${demoVideos.length} Demo Videos*` : undefined,
                parse_mode: 'Markdown'
            }));

            for (let i = 0; i < mediaGroup.length; i += 5) {
                const chunk = mediaGroup.slice(i, i + 5);
                await ctx.replyWithMediaGroup(chunk);
            }
        } catch (e) {
            for (const videoId of demoVideos) {
                try {
                    await ctx.replyWithVideo(videoId, { caption: "🎬 *Demo Preview*", parse_mode: "Markdown" });
                } catch (e2) {
                    console.error("Demo video send error:", e2.message);
                }
            }
        }

        await ctx.reply("📌 *Watch all demo videos above!*\n\nNow check the plan details below:", { parse_mode: "Markdown" });
    }

    await ctx.replyWithMarkdown(
        `${plan.description}\n\n📦 *${plan.name}*\n💰 Price: ₹${plan.price} | ⏳ ${plan.days} Days${demoVideos.length > 0 ? `\n📹 ${demoVideos.length} Demo Videos Available` : ''}`,
        Markup.inlineKeyboard([
            [Markup.button.callback("💳 Buy Now", `buy:${plan.id}`)],
            [Markup.button.callback("⬅️ Back to Plans", "back_to_plans")],
        ])
    );
}));

// ═══════════════════════════════════════════════════════════════════════════
// BUY NOW
// ═══════════════════════════════════════════════════════════════════════════

bot.action(/^buy:(.+)$/, safeHandler(async (ctx) => {
    await ctx.answerCbQuery();
    const data = getData();
    const plan = data.plans.find(p => p.id === ctx.match[1]);
    if (!plan) { await ctx.reply("❌ Plan not found."); return; }

    if (!data.upiId && getQrMode() === "auto") {
        await ctx.reply("⚠️ UPI ID not configured. Please contact admin.");
        return;
    }

    const orderId = `#${++orderCounter}`;
    setState(ctx.from.id, { type: "waiting_payment_proof", planId: plan.id, orderId });

    await sendPaymentQr(ctx, plan, data);

    await ctx.replyWithMarkdown(
        `1️⃣ Pay ₹${plan.price} to \`${data.upiId || "above QR"}\`\n` +
        `2️⃣ After payment, click ✅ *I Have Paid*\n\n` +
        `🪪 Order: ${orderId}`,
        Markup.inlineKeyboard([
            [Markup.button.callback("✅ I Have Paid", `paid:${plan.id}`)],
            [Markup.button.callback("❌ Cancel", "cancel_payment")],
        ])
    );
}));

// ═══════════════════════════════════════════════════════════════════════════
// I HAVE PAID
// ═══════════════════════════════════════════════════════════════════════════

bot.action(/^paid:(.+)$/, safeHandler(async (ctx) => {
    await ctx.answerCbQuery();
    const planId = ctx.match[1];
    const state  = getState(ctx.from.id);
    const orderId = state.type === "waiting_payment_proof" ? state.orderId : `#${++orderCounter}`;

    setState(ctx.from.id, {
        type: "waiting_payment_proof",
        planId,
        orderId,
        mode: "manual"
    });

    await ctx.replyWithMarkdown(
        "✅ *Great!*\n\n" +
        "📸 *Manual Verification*\n" +
        "Please send your *payment screenshot*.\n\n" +
        "⏱ Our team will verify it within 30 minutes."
    );
}));

bot.action("cancel_payment", safeHandler(async (ctx) => {
    await ctx.answerCbQuery("Cancelled");
    clearState(ctx.from.id);
    const data = getData();
    await sendWelcome(ctx, data);
}));

bot.action("howto", safeHandler(async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
        "📖 *How to Use:*\n\n" +
        "1️⃣ Choose a plan\n" +
        "2️⃣ Watch demo videos\n" +
        "3️⃣ Click *Buy Now*\n" +
        "4️⃣ Scan QR or pay via UPI\n" +
        "5️⃣ Click *I Have Paid*\n" +
        "6️⃣ Send your payment screenshot\n" +
        "7️⃣ Admin verifies it in ~30 minutes ⏱\n" +
        "8️⃣ Get access! 🎉",
        { parse_mode: "Markdown" }
    );
}));

bot.action("report", safeHandler(async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("🆘 *Report an Issue*\n\nDescribe your problem and our admin will look into it.", { parse_mode: "Markdown" });
}));

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: APPROVE / REJECT
// ═══════════════════════════════════════════════════════════════════════════

bot.action(/^approve:(\d+):([^:]+):(.+)$/, safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery("✅ Approved!");
    const [, userId, orderId, planEncoded] = ctx.match;
    let planName;
    try { planName = decodeURIComponent(planEncoded); } catch { planName = planEncoded; }

    updatePaymentStatus(orderId, "approved");

    const data = getData();
    const plan = data.plans.find(p => p.name === planName);
    const groupLink = plan?.groupLink || "🔗 Please contact admin for group link.";

    const msg = ctx.callbackQuery.message;
    try {
        if (msg.caption) {
            await ctx.editMessageCaption(msg.caption + "\n\n✅ *APPROVED*", { parse_mode: "Markdown" });
        } else if (msg.text) {
            await ctx.editMessageText(msg.text + "\n\n✅ *APPROVED*", { parse_mode: "Markdown" });
        }
    } catch {}

    try {
        await bot.telegram.sendMessage(
            userId,
            `✅ *Payment Approved!*\n\nYour plan *${planName}* has been activated. Enjoy! 🎉\n\n🔗 *Join the group:*\n${groupLink}`,
            { parse_mode: "Markdown" }
        );
    } catch {}
}));

bot.action(/^reject:(\d+):([^:]+):(.+)$/, safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery("❌ Rejected");
    const [, userId, orderId, planEncoded] = ctx.match;
    let planName;
    try { planName = decodeURIComponent(planEncoded); } catch { planName = planEncoded; }

    updatePaymentStatus(orderId, "rejected");

    const msg = ctx.callbackQuery.message;
    try {
        if (msg.caption) {
            await ctx.editMessageCaption(msg.caption + "\n\n❌ *REJECTED*", { parse_mode: "Markdown" });
        } else if (msg.text) {
            await ctx.editMessageText(msg.text + "\n\n❌ *REJECTED*", { parse_mode: "Markdown" });
        }
    } catch {}

    try {
        await bot.telegram.sendMessage(userId,
            `❌ *Payment Rejected*\n\nPayment for *${planName}* could not be verified.\n\nPlease send a clearer screenshot or correct ID.`,
            { parse_mode: "Markdown" });
    } catch {}
}));

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN PANEL — BACK BUTTON
// ═══════════════════════════════════════════════════════════════════════════

bot.action("admin_back", safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    clearState(ctx.from.id);

    const { text, keyboard } = buildAdminPanelKeyboard();

    try {
        await ctx.editMessageText(text, { parse_mode: "Markdown", ...keyboard });
    } catch {
        await ctx.replyWithMarkdown(text, keyboard);
    }
}));

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: SET UPI / QR — MAIN MENU (CUSTOM QR)
// ═══════════════════════════════════════════════════════════════════════════

bot.action("admin_set_upi", safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();

    const data = getData();
    const currentMode = getQrMode();
    const modeLabel = currentMode === "custom" ? "🖼️ Custom QR" : "⚡ Auto QR";
    const hasCustom = getCustomQrImageId() ? "✅ Set" : "❌ Not set";

    await ctx.replyWithMarkdown(
        `💳 *UPI / QR Settings*\n\n` +
        `📌 Current Mode: *${modeLabel}*\n` +
        `🆔 UPI ID: \`${data.upiId || "Not set"}\`\n` +
        `👤 UPI Name: ${data.upiName || "Not set"}\n` +
        `🖼️ Custom QR: ${hasCustom}\n\n` +
        `Choose an option:`,
        Markup.inlineKeyboard([
            [Markup.button.callback("⚡ Auto QR (UPI ID based)", "admin_qr_mode_auto")],
            [Markup.button.callback("🖼️ Custom QR (Upload Photo)", "admin_qr_mode_custom")],
            [Markup.button.callback("✏️ Change UPI ID & Name", "admin_change_upi")],
            [Markup.button.callback("👁️ Preview Current QR", "admin_preview_qr")],
            [Markup.button.callback("⬅️ Back to Admin", "admin_back")]
        ])
    );
}));

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: AUTO QR MODE
// ═══════════════════════════════════════════════════════════════════════════

bot.action("admin_qr_mode_auto", safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery("⚡ Auto QR Selected");

    setQrMode("auto");
    const data = getData();

    await ctx.replyWithMarkdown(
        `✅ *Auto QR Mode Enabled!*\n\n` +
        `🤖 Bot will now auto-generate QR from UPI ID:\n` +
        `🆔 \`${data.upiId || "Not set"}\`\n` +
        `👤 ${data.upiName || "Not set"}\n\n` +
        `💡 To change UPI ID, use *Change UPI ID & Name* option.`,
        Markup.inlineKeyboard([
            [Markup.button.callback("⬅️ Back", "admin_set_upi")]
        ])
    );
}));

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: CUSTOM QR MODE
// ═══════════════════════════════════════════════════════════════════════════

bot.action("admin_qr_mode_custom", safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery("🖼️ Custom QR Selected");

    setQrMode("custom");
    setState(ctx.from.id, { type: "admin_waiting_custom_qr" });

    await ctx.replyWithMarkdown(
        `🖼️ *Custom QR Mode Enabled!*\n\n` +
        `📸 Now send your *QR code photo*.\n\n` +
        `⚠️ This QR will be shown to users when they click *Buy Now*.\n` +
        `💡 Make sure the QR is clear and scannable.\n\n` +
        `❌ Type /cancel to abort.`,
        Markup.inlineKeyboard([
            [Markup.button.callback("⬅️ Back", "admin_set_upi")]
        ])
    );
}));

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: CHANGE UPI ID & NAME
// ═══════════════════════════════════════════════════════════════════════════

bot.action("admin_change_upi", safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    setState(ctx.from.id, { type: "admin_waiting_upi" });
    const d = getData();
    await ctx.reply(`💳 Current UPI: \`${d.upiId}\` (${d.upiName})\n\nSend new *UPI ID*:`, { parse_mode: "Markdown" });
}));

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: PREVIEW CURRENT QR
// ═══════════════════════════════════════════════════════════════════════════

bot.action("admin_preview_qr", safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();

    const data = getData();
    const mode = getQrMode();

    if (mode === "custom") {
        const customQrId = getCustomQrImageId();
        if (!customQrId) {
            await ctx.reply("❌ No custom QR set. Please upload one.");
            return;
        }
        try {
            await ctx.replyWithPhoto(customQrId, {
                caption: `🖼️ *Current QR (Custom Mode)*\n\n📌 Mode: Custom\n💰 Amount: Variable (per plan)`,
                parse_mode: "Markdown"
            });
        } catch (e) {
            await ctx.reply("❌ Failed to send custom QR. Please upload again.");
        }
    } else {
        try {
            const buf = await generateUpiQr(data.upiId, data.upiName || "Merchant", 0);
            await ctx.replyWithPhoto(
                { source: buf, filename: "qr_preview.png" },
                {
                    caption: `⚡ *Current QR (Auto Mode)*\n\n📌 Mode: Auto\n🆔 UPI: \`${data.upiId}\`\n👤 Name: ${data.upiName}`,
                    parse_mode: "Markdown"
                }
            );
        } catch (e) {
            await ctx.reply("❌ Failed to generate QR. Check UPI ID.");
        }
    }
}));

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: SET WELCOME IMAGE
// ═══════════════════════════════════════════════════════════════════════════

bot.action("admin_set_welcome_image", safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    setState(ctx.from.id, { type: "admin_waiting_welcome_image" });

    const data = getData();
    const current = data.welcomeImageId ? "🖼️ *Current image is set*" : "❌ *No image set*";

    await ctx.replyWithMarkdown(
        `🖼️ *Set Welcome Image*\n\n` +
        `${current}\n\n` +
        `📸 Now send the *photo* to attach with the welcome message.\n\n` +
        `⚠️ The welcome message and plan buttons will be added automatically.\n\n` +
        `💡 Tip: 1280x720 or 1920x1080 works best.`
    );
}));

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: REMOVE WELCOME IMAGE
// ═══════════════════════════════════════════════════════════════════════════

bot.action("admin_remove_welcome_image", safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    const data = getData();
    if (!data.welcomeImageId) {
        await ctx.answerCbQuery("❌ No image set");
        await ctx.replyWithMarkdown("❌ *No welcome image is set.*");
        return;
    }
    updateData({ welcomeImageId: null });
    await ctx.answerCbQuery("🗑️ Image removed!");
    await ctx.replyWithMarkdown(
        "✅ *Welcome image removed!*\n\nThe welcome message will now show as text only.",
        Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back to Admin", "admin_back")]])
    );
}));

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: BROADCAST
// ═══════════════════════════════════════════════════════════════════════════

bot.action("admin_broadcast", safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    clearState(ctx.from.id);

    const data = getData();
    let userCount = 0;
    if (data.users) {
        userCount = Array.isArray(data.users) ? data.users.length : Object.keys(data.users).length;
    }

    await ctx.replyWithMarkdown(
        `📢 *Broadcast Message*\n\n` +
        `👥 Total users: *${userCount}*\n\n` +
        `📝 Send the message you want to broadcast.\n\n` +
        `💡 You can send:\n` +
        `   • Text message\n` +
        `   • Photo with caption\n` +
        `   • Video with caption\n\n` +
        `⚠️ The message will be sent to *all users*.\n` +
        `Type /cancel to abort.`,
        Markup.inlineKeyboard([
            [Markup.button.callback("⬅️ Back to Admin", "admin_back")]
        ])
    );

    setState(ctx.from.id, { type: "admin_waiting_broadcast" });
}));

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: BROADCAST SEND
// ═══════════════════════════════════════════════════════════════════════════

bot.action("admin_broadcast_send", safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery("Sending...");

    const state = getState(ctx.from.id);
    if (state.type !== "admin_broadcast_confirm" || !state.payload) {
        await ctx.reply("⚠️ Broadcast session expired. Please try again.");
        return;
    }

    const { payload } = state;
    const data = getData();
    const users = extractUserIds(data.users);

    if (users.length === 0) {
        await ctx.editMessageText("❌ No users to broadcast to.");
        clearState(ctx.from.id);
        return;
    }

    const statusMsg = ctx.callbackQuery.message;
    let sent = 0;
    let failed = 0;
    let processed = 0;
    let lastProgressUpdate = 0;

    const updateProgress = async (force = false) => {
        const now = Date.now();
        if (!force && now - lastProgressUpdate < 3000) return;
        lastProgressUpdate = now;

        const percentage = Math.round((processed / users.length) * 100);
        const filled = Math.round(percentage / 10);
        const progressBar = "█".repeat(filled) + "░".repeat(10 - filled);

        try {
            await ctx.telegram.editMessageText(
                statusMsg.chat.id,
                statusMsg.message_id,
                null,
                `📢 *Broadcasting...*\n\n` +
                `${progressBar} ${percentage}%\n\n` +
                `📊 Progress: ${processed} / ${users.length}\n` +
                `✅ Sent: ${sent}\n` +
                `❌ Failed: ${failed}\n` +
                `⏱️ Est. remaining: ${Math.ceil((users.length - processed) / 25)}s`,
                { parse_mode: "Markdown" }
            );
        } catch (editErr) {
            console.error("Progress update error:", editErr.message);
        }
    };

    const sendOne = async (uid) => {
        try {
            if (payload.type === "text") {
                await bot.telegram.sendMessage(uid, payload.text, {
                    parse_mode: payload.parse_mode
                });
            } else if (payload.type === "photo") {
                await bot.telegram.sendPhoto(uid, payload.fileId, {
                    caption: payload.caption,
                    parse_mode: payload.parse_mode
                });
            } else if (payload.type === "video") {
                await bot.telegram.sendVideo(uid, payload.fileId, {
                    caption: payload.caption,
                    parse_mode: payload.parse_mode
                });
            }
            sent++;
        } catch (e) {
            failed++;
            const errCode = e?.response?.error_code;
            const errDesc = e?.response?.description || "";

            if (errCode === 403) {
                console.log(`🚫 User ${uid} blocked bot`);
            } else if (errCode === 429) {
                const retry = e.response.parameters?.retry_after || 5;
                console.warn(`⚠️ Rate limited, waiting ${retry}s`);
                await new Promise(r => setTimeout(r, retry * 1000));
            } else {
                console.error(`❌ Failed to send to ${uid}:`, errDesc || e.message);
            }
        }
        processed++;
    };

    for (let i = 0; i < users.length; i += PERF.BROADCAST_BATCH_SIZE) {
        const batch = users.slice(i, i + PERF.BROADCAST_BATCH_SIZE);

        for (let j = 0; j < batch.length; j += PERF.BROADCAST_MAX_CONCURRENT) {
            const chunk = batch.slice(j, j + PERF.BROADCAST_MAX_CONCURRENT);
            await Promise.all(chunk.map(uid => sendOne(uid)));
            await updateProgress();
            await new Promise(r => setTimeout(r, 200));
        }

        await new Promise(r => setTimeout(r, PERF.BROADCAST_BATCH_DELAY_MS));
        await updateProgress(true);
    }

    try {
        await ctx.telegram.editMessageText(
            statusMsg.chat.id,
            statusMsg.message_id,
            null,
            `✅ *Broadcast Complete!*\n\n` +
            `📨 Total: *${users.length}*\n` +
            `✅ Sent: *${sent}*\n` +
            `❌ Failed: *${failed}*\n` +
            `📈 Success Rate: *${Math.round((sent / users.length) * 100)}%*`,
            {
                parse_mode: "Markdown",
                ...Markup.inlineKeyboard([
                    [Markup.button.callback("⬅️ Back to Admin", "admin_back")]
                ])
            }
        );
    } catch {}

    clearState(ctx.from.id);
}));

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: BROADCAST CANCEL
// ═══════════════════════════════════════════════════════════════════════════

bot.action("admin_broadcast_cancel", safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery("Cancelled");
    clearState(ctx.from.id);
    try {
        await ctx.editMessageText("❌ *Broadcast cancelled.*", { parse_mode: "Markdown" });
    } catch {}
}));

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: PLAN GROUP LINK
// ═══════════════════════════════════════════════════════════════════════════

bot.action(/^admin_set_plan_link:([^:]+)$/, safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    setState(ctx.from.id, { type: "admin_waiting_plan_link", planId: ctx.match[1] });
    await ctx.reply("🔗 Send the *Group Link* for this plan:\n\nExample: `https://t.me/+xxxxxxxxxxx`", { parse_mode: "Markdown" });
}));

// ═══════════════════════════════════════════════════════════════════════════
// PLAN DELETE
// ═══════════════════════════════════════════════════════════════════════════

bot.action(/^delete_plan_confirm:([^:]+)$/, safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    const plan = getPlan(ctx.match[1]);
    if (!plan) { await ctx.reply("❌ Plan not found."); return; }

    await ctx.replyWithMarkdown(
        `⚠️ *Delete Plan Confirmation*\n\n` +
        `📦 Name: *${plan.name}*\n` +
        `💰 Price: ₹${plan.price}\n` +
        `⏳ Days: ${plan.days}\n` +
        `📹 Demo Videos: ${plan.demoVideos?.length || 0}\n\n` +
        `🚨 *Are you sure you want to delete this plan?*\n` +
        `_This action cannot be undone!_`,
        Markup.inlineKeyboard([
            [Markup.button.callback("✅ Yes, Delete It", `delete_plan_execute:${plan.id}`)],
            [Markup.button.callback("❌ Cancel", `admin_plan_details:${plan.id}`)]
        ])
    );
}));

bot.action(/^delete_plan_execute:([^:]+)$/, safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    const planId = ctx.match[1];
    const plan = getPlan(planId);
    if (!plan) {
        await ctx.answerCbQuery("❌ Not found");
        await ctx.reply("❌ Plan not found or already deleted.");
        return;
    }

    const planName = plan.name;
    const result = deletePlan(planId);

    if (result) {
        await ctx.answerCbQuery("🗑️ Plan Deleted!");
        try {
            await ctx.editMessageText(
                `✅ *Plan Deleted Successfully!*\n\n` +
                `📦 Removed: *${planName}*`,
                {
                    parse_mode: "Markdown",
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback("📋 View Plans", "admin_view_plans")],
                        [Markup.button.callback("⬅️ Back to Admin", "admin_back")]
                    ])
                }
            );
        } catch {
            await ctx.replyWithMarkdown(`✅ *Plan Deleted Successfully!*\n\n📦 Removed: *${planName}*`);
        }
    } else {
        await ctx.answerCbQuery("❌ Failed");
    }
}));

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: REMOVE VIDEO
// ═══════════════════════════════════════════════════════════════════════════

bot.action(/^delvid:(\d+)$/, safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    const data = getData();
    const vids = [...(data.welcomeVideoIds || [])];
    vids.splice(parseInt(ctx.match[1]), 1);
    updateData({ welcomeVideoIds: vids });
    await ctx.replyWithMarkdown("✅ Video removed.");
}));

// ═══════════════════════════════════════════════════════════════════════════
// DEMO VIDEOS
// ═══════════════════════════════════════════════════════════════════════════

bot.action(/^add_demo:([^:]+)$/, safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    const planId = ctx.match[1];
    setState(ctx.from.id, { type: "admin_waiting_demo_video", planId });
    await ctx.reply("🎬 Send *multiple videos at once* to add as demos for this plan:\n\nSend up to 5-6 videos in one message batch.\n\n_You can send all videos together!_", { parse_mode: "Markdown" });
}));

bot.action(/^remove_demo:([^:]+):(\d+)$/, safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    const data = getData();
    const plan = data.plans.find(p => p.id === ctx.match[1]);
    if (!plan) { await ctx.reply("Plan not found."); return; }
    if (!Array.isArray(plan.demoVideos)) plan.demoVideos = [];
    plan.demoVideos.splice(parseInt(ctx.match[2]), 1);
    updateData({ plans: data.plans });
    await ctx.replyWithMarkdown(`✅ Demo video removed from *${plan.name}*`);
}));

// ═══════════════════════════════════════════════════════════════════════════
// EDIT PLAN
// ═══════════════════════════════════════════════════════════════════════════

bot.action(/^edit_plan:([^:]+)$/, safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    const planId = ctx.match[1];
    const plan = getPlan(planId);
    if (!plan) { await ctx.reply("❌ Plan not found."); return; }

    await ctx.replyWithMarkdown(
        `✏️ *Edit Plan: ${plan.name}*\n\nChoose what to edit:`,
        Markup.inlineKeyboard([
            [Markup.button.callback("📛 Name", `edit_plan_name:${planId}`)],
            [Markup.button.callback("💰 Price", `edit_plan_price:${planId}`)],
            [Markup.button.callback("⏳ Days", `edit_plan_days:${planId}`)],
            [Markup.button.callback("📝 Description", `edit_plan_desc:${planId}`)],
            [Markup.button.callback("🔗 Group Link", `admin_set_plan_link:${planId}`)],
            [Markup.button.callback("⬅️ Back", `admin_plan_details:${planId}`)],
        ])
    );
}));

bot.action(/^edit_plan_name:([^:]+)$/, safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    setState(ctx.from.id, { type: "admin_waiting_edit_name", planId: ctx.match[1] });
    await ctx.reply("✏️ Send the new *plan name*:", { parse_mode: "Markdown" });
}));

bot.action(/^edit_plan_price:([^:]+)$/, safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    const plan = getPlan(ctx.match[1]);
    setState(ctx.from.id, { type: "admin_waiting_edit_price", planId: ctx.match[1] });
    await ctx.reply(`✏️ Current Price: ₹${plan?.price || 0}\n\nSend the new *price* in ₹:`, { parse_mode: "Markdown" });
}));

bot.action(/^edit_plan_days:([^:]+)$/, safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    const plan = getPlan(ctx.match[1]);
    setState(ctx.from.id, { type: "admin_waiting_edit_days", planId: ctx.match[1] });
    await ctx.reply(`✏️ Current Days: ${plan?.days || 0}\n\nSend the new *validity in days*:`, { parse_mode: "Markdown" });
}));

bot.action(/^edit_plan_desc:([^:]+)$/, safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    const plan = getPlan(ctx.match[1]);
    setState(ctx.from.id, { type: "admin_waiting_edit_desc", planId: ctx.match[1] });
    await ctx.reply(`✏️ Current Description:\n\n${plan?.description || 'No description'}\n\nSend the new *description*:`, { parse_mode: "Markdown" });
}));

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: PLAN DETAILS
// ═══════════════════════════════════════════════════════════════════════════

bot.action(/^admin_plan_details:([^:]+)$/, safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    const data = getData();
    const plan = data.plans.find(p => p.id === ctx.match[1]);
    if (!plan) { await ctx.reply("Plan not found."); return; }

    const demoCount = Array.isArray(plan.demoVideos) ? plan.demoVideos.length : 0;

    let msg = `📋 *Plan Details*\n\n`;
    msg += `📦 Name: *${plan.name}*\n`;
    msg += `💰 Price: ₹${plan.price}\n`;
    msg += `⏳ Days: ${plan.days}\n`;
    msg += `📹 Demo Videos: ${demoCount}\n`;
    msg += `🔗 Group Link: \`${plan.groupLink || 'Not set'}\`\n`;
    msg += `📝 Description:\n${(plan.description || 'No description').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&')}`;

    const buttons = [];
    if (demoCount > 0) {
        buttons.push([Markup.button.callback(`📹 ${demoCount} Demo Videos`, `view_demo_videos:${plan.id}`)]);
    }
    buttons.push([Markup.button.callback("✏️ Edit Plan", `edit_plan:${plan.id}`)]);
    buttons.push([Markup.button.callback("➕ Add Demo Videos", `add_demo:${plan.id}`)]);
    if (demoCount > 0) {
        buttons.push([Markup.button.callback("🗑️ Remove Demo Video", `remove_demo_video:${plan.id}`)]);
    }
    buttons.push([Markup.button.callback("🔗 Set Group Link", `admin_set_plan_link:${plan.id}`)]);
    buttons.push([Markup.button.callback("🗑️ Delete This Plan", `delete_plan_confirm:${plan.id}`)]);
    buttons.push([Markup.button.callback("⬅️ Back", "admin_view_plans")]);

    await ctx.replyWithMarkdown(msg, Markup.inlineKeyboard(buttons));
}));

bot.action(/^remove_demo_video:([^:]+)$/, safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    const data = getData();
    const plan = data.plans.find(p => p.id === ctx.match[1]);
    if (!plan || !plan.demoVideos || plan.demoVideos.length === 0) {
        await ctx.reply("No demo videos to remove.");
        return;
    }

    const buttons = plan.demoVideos.map((_, i) => [
        Markup.button.callback(`❌ Video ${i+1}`, `remove_demo:${plan.id}:${i}`)
    ]);
    buttons.push([Markup.button.callback("⬅️ Back", `admin_plan_details:${plan.id}`)]);

    await ctx.reply(`Choose a demo video to remove from *${plan.name}*:`, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard(buttons)
    });
}));

bot.action(/^view_demo_videos:([^:]+)$/, safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    const data = getData();
    const plan = data.plans.find(p => p.id === ctx.match[1]);
    if (!plan || !plan.demoVideos || plan.demoVideos.length === 0) {
        await ctx.reply("No demo videos available.");
        return;
    }

    await ctx.reply(`📹 *${plan.name} - Demo Videos*\n\nShowing ${plan.demoVideos.length} videos:`, { parse_mode: "Markdown" });

    try {
        const mediaGroup = plan.demoVideos.map((videoId, index) => ({
            type: 'video',
            media: videoId,
            caption: index === 0 ? `🎬 ${plan.demoVideos.length} Demo Videos` : undefined
        }));

        for (let i = 0; i < mediaGroup.length; i += 5) {
            const chunk = mediaGroup.slice(i, i + 5);
            await ctx.replyWithMediaGroup(chunk);
        }
    } catch (e) {
        for (const videoId of plan.demoVideos) {
            try {
                await ctx.replyWithVideo(videoId, {
                    caption: `🎬 Demo Video`,
                    parse_mode: "Markdown"
                });
            } catch (e2) {
                console.error("Error sending demo video:", e2.message);
            }
        }
    }

    await ctx.reply("⬅️ Click back to return:", Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Back to Plan", `admin_plan_details:${plan.id}`)]
    ]));
}));

// ═══════════════════════════════════════════════════════════════════════════
// /admin COMMAND (FIXED — uses shared buildAdminPanelKeyboard)
// ═══════════════════════════════════════════════════════════════════════════

bot.command("admin", safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { await ctx.reply("❌ Not authorized."); return; }
    clearState(ctx.from.id);

    const { text, keyboard } = buildAdminPanelKeyboard();

    await ctx.replyWithMarkdown(text, keyboard);
}));

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: STATS
// ═══════════════════════════════════════════════════════════════════════════

bot.action("admin_stats", safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();

    const s = getStats();
    const qrMode = getQrMode() === "custom" ? "🖼️ Custom" : "⚡ Auto";

    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    const memory = process.memoryUsage();
    const memMB = Math.round(memory.heapUsed / 1024 / 1024);

    await ctx.replyWithMarkdown(
        `📊 *Bot Statistics*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👥 *Users & Bots*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👤 Total Users: *${s.totalUsers}*\n` +
        `💳 QR Mode: *${qrMode}*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `💰 *Payment Overview*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📨 Total Received: *${s.totalPayments}*\n` +
        `✅ Approved: *${s.approved}*\n` +
        `⏳ Pending: *${s.pending}*\n` +
        `❌ Rejected: *${s.rejected}*\n\n` +
        `💵 *Total Revenue: ₹${s.totalRevenue}*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `⚙️ *System Info*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `⏱️ Uptime: *${hours}h ${minutes}m ${seconds}s*\n` +
        `💾 Memory: *${memMB} MB*\n` +
        `📦 Node: *${process.version}*\n` +
        `📌 State Entries: *${userStates.size}*`
    );
}));

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: RECENT PAYMENTS
// ═══════════════════════════════════════════════════════════════════════════

bot.action("admin_recent_payments", safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    const data = getData();
    const recent = [...data.payments].reverse().slice(0, 10);
    if (!recent.length) { await ctx.reply("No payments yet."); return; }
    const lines = recent.map(p => {
        const icon = p.status === "approved" ? "✅" : p.status === "rejected" ? "❌" : "⏳";
        const date = new Date(p.submittedAt).toLocaleDateString("en-IN");
        return `${icon} *${p.planName}* — ₹${p.amount}\n   👤 ${p.userName} | ${date}`;
    });
    await ctx.replyWithMarkdown(`💰 *Recent 10 Payments:*\n\n${lines.join("\n\n")}`);
}));

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: VIEW PLANS
// ═══════════════════════════════════════════════════════════════════════════

bot.action("admin_view_plans", safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    const data = getData();
    if (!data.plans.length) { await ctx.reply("No plans configured."); return; }

    const buttons = data.plans.map(p => [
        Markup.button.callback(`📋 ${p.name} (${p.demoVideos?.length || 0} demos)`, `admin_plan_details:${p.id}`)
    ]);
    buttons.push([Markup.button.callback("⬅️ Back", "admin_back")]);

    await ctx.reply("📋 *Select a plan to manage:*", {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard(buttons)
    });
}));

bot.action("admin_add_plan", safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    setState(ctx.from.id, { type: "admin_waiting_plan_name" });
    await ctx.reply("✏️ Send the *plan name*:", { parse_mode: "Markdown" });
}));

bot.action("admin_add_video", safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    setState(ctx.from.id, { type: "admin_waiting_video" });
    await ctx.reply("🎬 Send a *video* (max 5):", { parse_mode: "Markdown" });
}));

bot.action("admin_remove_video", safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    const data = getData();
    if (!data.welcomeVideoIds?.length) { await ctx.reply("No welcome videos."); return; }
    await ctx.reply("Choose a video to remove:", Markup.inlineKeyboard(
        data.welcomeVideoIds.map((id, i) => [Markup.button.callback(`❌ Video ${i+1}`, `delvid:${i}`)])
    ));
}));

bot.action("admin_set_welcome", safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    setState(ctx.from.id, { type: "admin_waiting_welcome" });
    await ctx.reply("✏️ Send the new *welcome message*:", { parse_mode: "Markdown" });
}));

bot.action("admin_set_admin_id", safeHandler(async (ctx) => {
    if (!isAdmin(ctx.chat.id)) { ctx.answerCbQuery("Unauthorized"); return; }
    await ctx.answerCbQuery();
    setState(ctx.from.id, { type: "admin_waiting_admin_id" });
    await ctx.reply(`👤 Current Admin ID: \`${getData().adminChatId}\`\n\nSend new *Admin Chat ID*:`, { parse_mode: "Markdown" });
}));

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function extractUserIds(users) {
    const ids = new Set();
    if (!users) return [];
    if (Array.isArray(users)) {
        for (const u of users) {
            const id = u?.id ?? u?.chatId ?? u?.userId;
            if (id) ids.add(String(id));
        }
    } else if (typeof users === "object") {
        for (const [k, v] of Object.entries(users)) {
            const id = v?.id ?? v?.chatId ?? v?.userId ?? k;
            if (id) ids.add(String(id));
        }
    }
    return [...ids];
}

// ═══════════════════════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════════════════

bot.on("message", safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    const state = getState(userId);
    const text = ctx.message.text ?? "";

    // ═══════════════ ADMIN INPUT STATES ═══════════════
    if (isAdmin(chatId)) {

        // CUSTOM QR UPLOAD
        if (state.type === "admin_waiting_custom_qr") {
            const photos = ctx.message.photo;
            if (photos && photos.length > 0) {
                const fileId = photos[photos.length - 1].file_id;
                setCustomQrImageId(fileId);
                setQrMode("custom");
                clearState(userId);
                await ctx.replyWithMarkdown(
                    `✅ *Custom QR Set Successfully!*\n\n` +
                    `📌 Mode: *Custom QR*\n` +
                    `🖼️ All users will now see this QR when they click *Buy Now*.\n\n` +
                    `💡 Use /admin → 💳 Set UPI / QR to change anytime.`
                );
                try {
                    await ctx.replyWithPhoto(fileId, {
                        caption: "🖼️ *Preview* — This QR will be shown to users",
                        parse_mode: "Markdown"
                    });
                } catch {}
            } else if (ctx.message.document && ctx.message.document.mime_type?.startsWith("image/")) {
                setCustomQrImageId(ctx.message.document.file_id);
                setQrMode("custom");
                clearState(userId);
                await ctx.replyWithMarkdown("✅ *Custom QR Set!* (document mode)");
            } else {
                await ctx.reply("❌ Please send a *photo* of your QR code.", { parse_mode: "Markdown" });
            }
            return;
        }

        // BROADCAST INPUT
        if (state.type === "admin_waiting_broadcast") {
            let payload = null;

            if (ctx.message.photo) {
                const photos = ctx.message.photo;
                payload = {
                    type: "photo",
                    fileId: photos[photos.length - 1].file_id,
                    caption: ctx.message.caption || "",
                    parse_mode: "Markdown"
                };
            } else if (ctx.message.video) {
                payload = {
                    type: "video",
                    fileId: ctx.message.video.file_id,
                    caption: ctx.message.caption || "",
                    parse_mode: "Markdown"
                };
            } else if (text) {
                payload = {
                    type: "text",
                    text: text,
                    parse_mode: "Markdown"
                };
            } else {
                await ctx.reply("❌ Unsupported message type. Send text, photo, or video.");
                return;
            }

            const data = getData();
            const users = extractUserIds(data.users);

            setState(userId, {
                type: "admin_broadcast_confirm",
                payload
            });

            const preview = payload.type === "text"
                ? `📝 ${payload.text.slice(0, 200)}${payload.text.length > 200 ? "..." : ""}`
                : `🖼️ ${payload.type} with caption: ${(payload.caption || "").slice(0, 150)}${(payload.caption || "").length > 150 ? "..." : ""}`;

            await ctx.replyWithMarkdown(
                `📢 *Broadcast Preview*\n\n` +
                `${preview}\n\n` +
                `👥 Will be sent to *${users.length}* users.\n\n` +
                `⚠️ Are you sure?`,
                Markup.inlineKeyboard([
                    [Markup.button.callback("✅ Send to All", "admin_broadcast_send")],
                    [Markup.button.callback("❌ Cancel", "admin_broadcast_cancel")]
                ])
            );
            return;
        }

        // WELCOME IMAGE INPUT
        if (state.type === "admin_waiting_welcome_image") {
            const photos = ctx.message.photo;
            if (photos && photos.length > 0) {
                const fileId = photos[photos.length - 1].file_id;
                updateData({ welcomeImageId: fileId });
                clearState(userId);
                await ctx.replyWithMarkdown(
                    `✅ *Welcome Image Set!*\n\n` +
                    `🖼️ Now every new user will receive this image attached with the welcome message.`
                );
                try {
                    await ctx.replyWithPhoto(fileId, {
                        caption: "🖼️ *Preview* — This is what users will see",
                        parse_mode: "Markdown"
                    });
                } catch {}
            } else if (ctx.message.document && ctx.message.document.mime_type?.startsWith("image/")) {
                updateData({ welcomeImageId: ctx.message.document.file_id });
                clearState(userId);
                await ctx.replyWithMarkdown("✅ *Welcome Image Set!* (document mode)");
            } else {
                await ctx.reply("❌ Please send a *photo* (image).", { parse_mode: "Markdown" });
            }
            return;
        }

        // EDIT PLAN NAME
        if (state.type === "admin_waiting_edit_name") {
            if (!text) { await ctx.reply("Send a valid plan name."); return; }
            const result = updatePlan(state.planId, { name: text.trim() });
            if (result) {
                clearState(userId);
                await ctx.replyWithMarkdown(`✅ Plan name updated to: *${text.trim()}*`);
            } else { await ctx.reply("❌ Plan not found."); }
            return;
        }

        // EDIT PRICE
        if (state.type === "admin_waiting_edit_price") {
            const price = parseInt(text);
            if (isNaN(price) || price <= 0) { await ctx.reply("❌ Valid price needed."); return; }
            if (updatePlan(state.planId, { price })) {
                clearState(userId);
                await ctx.replyWithMarkdown(`✅ Plan price updated to: *₹${price}*`);
            } else { await ctx.reply("❌ Plan not found."); }
            return;
        }

        // EDIT DAYS
        if (state.type === "admin_waiting_edit_days") {
            const days = parseInt(text);
            if (isNaN(days) || days <= 0) { await ctx.reply("❌ Valid days needed."); return; }
            if (updatePlan(state.planId, { days })) {
                clearState(userId);
                await ctx.replyWithMarkdown(`✅ Plan days updated to: *${days} days*`);
            } else { await ctx.reply("❌ Plan not found."); }
            return;
        }

        // EDIT DESCRIPTION
        if (state.type === "admin_waiting_edit_desc") {
            if (!text) { await ctx.reply("Send a valid description."); return; }
            if (updatePlan(state.planId, { description: text.trim() })) {
                clearState(userId);
                await ctx.replyWithMarkdown(`✅ Plan description updated!`);
            } else { await ctx.reply("❌ Plan not found."); }
            return;
        }

        // ADD PLAN: NAME
        if (state.type === "admin_waiting_plan_name") {
            if (!text) { await ctx.reply("Send a valid plan name."); return; }
            setState(userId, { type: "admin_waiting_plan_price", name: text.trim() });
            await ctx.reply(`✅ Name: *${text.trim()}*\n\nSend *price* in ₹:`, { parse_mode: "Markdown" });
            return;
        }

        // ADD PLAN: PRICE
        if (state.type === "admin_waiting_plan_price") {
            const price = parseInt(text);
            if (isNaN(price) || price <= 0) { await ctx.reply("❌ Valid price needed."); return; }
            setState(userId, { type: "admin_waiting_plan_days", name: state.name, price });
            await ctx.reply(`✅ Price: ₹${price}\n\nSend *validity in days*:`, { parse_mode: "Markdown" });
            return;
        }

        // ADD PLAN: DAYS
        if (state.type === "admin_waiting_plan_days") {
            const days = parseInt(text);
            if (isNaN(days) || days <= 0) { await ctx.reply("❌ Valid days needed."); return; }
            setState(userId, { type: "admin_waiting_plan_desc", name: state.name, price: state.price, days });
            await ctx.reply(`✅ Days: ${days}\n\nSend the *plan description*:`, { parse_mode: "Markdown" });
            return;
        }

        // ADD PLAN: DESC
        if (state.type === "admin_waiting_plan_desc") {
            if (!text) { await ctx.reply("Send a valid description."); return; }
            const newPlan = addPlan({
                name: state.name,
                price: state.price,
                days: state.days,
                description: text.trim(),
                groupLink: "",
                demoVideos: []
            });
            clearState(userId);
            await ctx.replyWithMarkdown(
                `✅ *Plan Added!*\n\n` +
                `📦 ${newPlan.name}\n` +
                `💰 ₹${newPlan.price} / ${newPlan.days} days\n\n` +
                `⚠️ Add group link via admin panel.\n` +
                `📹 Add demo videos via admin panel.`
            );
            return;
        }

        // UPI ID
        if (state.type === "admin_waiting_upi") {
            if (!text) { await ctx.reply("Send a valid UPI ID."); return; }
            updateData({ upiId: text.trim() });
            setState(userId, { type: "admin_waiting_upi_name" });
            await ctx.reply(`✅ UPI ID: \`${text.trim()}\`\n\nNow send the *Account Name*:`, { parse_mode: "Markdown" });
            return;
        }

        // UPI NAME
        if (state.type === "admin_waiting_upi_name") {
            if (!text) { await ctx.reply("Send a valid name."); return; }
            updateData({ upiName: text.trim() });
            clearState(userId);
            try {
                const d = getData();
                const buf = await generateUpiQr(d.upiId, text.trim(), 0);
                await ctx.replyWithPhoto(
                    { source: buf, filename: "qr_preview.png" },
                    { caption: `✅ UPI updated!\n🆔 ${d.upiId}\n👤 ${text.trim()}\n\nQR auto-generated ✅` }
                );
            } catch {
                await ctx.reply(`✅ UPI Name set: *${text.trim()}*`, { parse_mode: "Markdown" });
            }
            return;
        }

        // WELCOME VIDEO
        if (state.type === "admin_waiting_video") {
            if (ctx.message.video) {
                const data = getData();
                if (data.welcomeVideoIds.length >= 5) {
                    await ctx.reply("⚠️ Max 5 videos. Remove one first.");
                } else {
                    updateData({ welcomeVideoIds: [...data.welcomeVideoIds, ctx.message.video.file_id] });
                    clearState(userId);
                    await ctx.reply(`✅ Video added! Total: ${data.welcomeVideoIds.length + 1}/5`);
                }
            } else {
                await ctx.reply("❌ Send a video file.");
            }
            return;
        }

        // WELCOME MESSAGE
        if (state.type === "admin_waiting_welcome") {
            if (!text) { await ctx.reply("Send a valid message."); return; }
            updateData({ welcomeMessage: text.trim() });
            clearState(userId);
            await ctx.reply("✅ Welcome message updated!");
            return;
        }

        // ADMIN CHAT ID (with new admin notification)
        if (state.type === "admin_waiting_admin_id") {
            if (!text || isNaN(Number(text.trim()))) {
                await ctx.reply("❌ Send a valid numeric Chat ID.");
                return;
            }
            const newAdminId = text.trim();
            updateData({ adminChatId: newAdminId });
            clearState(userId);
            await ctx.replyWithMarkdown(`✅ Admin Chat ID changed to: \`${newAdminId}\`\n\n⚠️ Use new ID for admin access.`);

            // Notify new admin
            try {
                await bot.telegram.sendMessage(
                    newAdminId,
                    `🎉 *You are now an Admin!*\n\n` +
                    `Use /admin to access the Admin Panel.\n\n` +
                    `💡 You can now:\n` +
                    `• Set UPI / QR (Auto or Custom)\n` +
                    `• Manage plans\n` +
                    `• Broadcast messages\n` +
                    `• View stats`,
                    { parse_mode: "Markdown" }
                );
            } catch (e) {
                console.log("Could not notify new admin:", e.message);
            }
            return;
        }

        // DEMO VIDEO UPLOAD
        if (state.type === "admin_waiting_demo_video") {
            if (ctx.message.video) {
                const data = getData();
                const plan = data.plans.find(p => p.id === state.planId);
                if (!plan) { await ctx.reply("❌ Plan not found."); clearState(userId); return; }

                if (!Array.isArray(plan.demoVideos)) plan.demoVideos = [];
                if (plan.demoVideos.length >= 15) {
                    await ctx.reply("⚠️ Max 15 demo videos per plan. Remove some first.");
                    return;
                }

                plan.demoVideos.push(ctx.message.video.file_id);
                updateData({ plans: data.plans });

                await ctx.reply(`✅ Demo video added to *${plan.name}*! (${plan.demoVideos.length}/15)`, {
                    parse_mode: "Markdown",
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback("➕ Add More", `add_demo:${plan.id}`)],
                        [Markup.button.callback("⬅️ Back to Plan", `admin_plan_details:${plan.id}`)]
                    ])
                });
            } else if (ctx.message.mediaGroupId) {
                await ctx.reply("✅ Batch videos received!");
            } else {
                await ctx.reply("❌ Please send a video file.");
            }
            return;
        }

        // PLAN GROUP LINK
        if (state.type === "admin_waiting_plan_link") {
            const data = getData();
            const plan = data.plans.find(p => p.id === state.planId);
            if (!plan) { await ctx.reply("❌ Plan not found."); clearState(userId); return; }

            let link = (text || "").trim();
            if (!link.startsWith('https://t.me/')) {
                await ctx.reply("❌ Invalid link! Please send a valid Telegram group link.\n\nExample: `https://t.me/+xxxxxxxxxxx`", { parse_mode: "Markdown" });
                return;
            }

            plan.groupLink = link;
            updateData({ plans: data.plans });
            clearState(userId);
            await ctx.replyWithMarkdown(`✅ Group link updated for *${plan.name}*!\n\n🔗 ${link}`);
            return;
        }
    }

    // ═══════════════ USER: WAITING PAYMENT PROOF ═══════════════
    if (state.type === "waiting_payment_proof") {
        const { planId, orderId } = state;
        const data = getData();
        const plan = data.plans.find(p => p.id === planId);
        const planName = plan?.name ?? planId;
        const userName = `${ctx.from.first_name ?? ""} ${ctx.from.last_name ?? ""}`.trim();
        const amount = plan?.price ?? 0;

        // Photo/document → manual
        if (ctx.message.photo || ctx.message.document) {
            addPayment({
                userId: String(userId),
                userName,
                planId,
                planName,
                amount,
                orderId
            });

            const info =
                `👤 User: [${userName}](tg://user?id=${userId})\n` +
                `🆔 ID: \`${userId}\`\n` +
                `🪪 Order: ${orderId}\n` +
                `📦 Plan: *${planName}*\n` +
                `💰 Amount: ₹${amount}\n\n` +
                `📸 Manual verification required:`;

            const approveBtn = `approve:${userId}:${orderId}:${encodeURIComponent(planName)}`;
            const rejectBtn = `reject:${userId}:${orderId}:${encodeURIComponent(planName)}`;
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback("✅ Approve", approveBtn), Markup.button.callback("❌ Reject", rejectBtn)]
            ]);

            try {
                if (ctx.message.photo) {
                    const photos = ctx.message.photo;
                    await bot.telegram.sendPhoto(data.adminChatId, photos[photos.length - 1].file_id, {
                        caption: info,
                        parse_mode: "Markdown",
                        ...keyboard
                    });
                } else if (ctx.message.document) {
                    await bot.telegram.sendDocument(data.adminChatId, ctx.message.document.file_id, {
                        caption: info,
                        parse_mode: "Markdown",
                        ...keyboard
                    });
                }
            } catch (e) { console.error("Forward error:", e.message); }

            clearState(userId);
            await ctx.replyWithMarkdown("✅ *Payment proof submitted!*\n\nOur team will verify within *30 minutes*. 🙏");
            return;
        }

        // Text
        if (text && !text.startsWith("/")) {
            await ctx.replyWithMarkdown(
                "📸 *Manual Verification Only*\n\n" +
                "Please send a *screenshot* of your payment.\n\n" +
                "Text transaction IDs are not accepted."
            );
            return;
        }

    }

    // Default reply
    if (text && !text.startsWith("/")) {
        const data = getData();
        await sendWelcome(ctx, data);
    }
}));

// ═══════════════════════════════════════════════════════════════════════════
// MEDIA GROUP HANDLER
// ═══════════════════════════════════════════════════════════════════════════

bot.on('media_group', safeHandler(async (ctx) => {
    const state = getState(ctx.from.id);

    if (state.type === "admin_waiting_demo_video" && isAdmin(ctx.chat.id)) {
        const data = getData();
        const plan = data.plans.find(p => p.id === state.planId);
        if (!plan) return;

        if (!Array.isArray(plan.demoVideos)) plan.demoVideos = [];
        if (plan.demoVideos.length >= 15) {
            await ctx.reply("⚠️ Max 15 demo videos per plan.");
            return;
        }

        let added = 0;
        for (const msg of ctx.message.mediaGroup) {
            if (msg.video && plan.demoVideos.length < 15) {
                plan.demoVideos.push(msg.video.file_id);
                added++;
            }
        }

        updateData({ plans: data.plans });
        await ctx.reply(`✅ Added ${added} demo videos to *${plan.name}*! (${plan.demoVideos.length}/15)`, {
            parse_mode: "Markdown"
        });
        clearState(ctx.from.id);
    }
}));

// ═══════════════════════════════════════════════════════════════════════════
// /cancel COMMAND
// ═══════════════════════════════════════════════════════════════════════════

bot.command("cancel", safeHandler(async (ctx) => {
    clearState(ctx.from.id);
    await ctx.reply("✅ Cancelled. Use /start to begin again.");
}));

// ═══════════════════════════════════════════════════════════════════════════
// ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════

bot.catch((err, ctx) => {
    const code = err?.response?.error_code;
    const desc = err?.response?.description || "";
    if (code === 403) return;
    if (code === 400 && desc.includes("query is too old")) return;
    if (code === 429) {
        console.error("⚠️ Rate limit hit:", desc);
        return;
    }
    console.error("❌ Bot error:", err.message || err);
    if (err.stack) console.error(err.stack);
    try {
        if (ctx?.reply) ctx.reply("⚠️ An error occurred. Please try again.").catch(() => {});
    } catch {}
});

// ═══════════════════════════════════════════════════════════════════════════
// LAUNCH
// ═══════════════════════════════════════════════════════════════════════════

loadData();
console.log("🤖 Starting bot v7.1.1 (Fixed /admin + Custom QR + High-Traffic)...");

try {
    const d = getData();
    if (typeof d.welcomeImageId === "undefined") {
        updateData({ welcomeImageId: null });
        console.log("✅ Initialized welcomeImageId = null");
    }
    if (!Array.isArray(d.welcomeVideoIds)) {
        updateData({ welcomeVideoIds: [] });
        console.log("✅ Initialized welcomeVideoIds = []");
    }
    if (typeof d.qrMode === "undefined") {
        updateData({ qrMode: "auto" });
        console.log("✅ Initialized qrMode = auto");
    }
    if (typeof d.customQrImageId === "undefined") {
        updateData({ customQrImageId: null });
        console.log("✅ Initialized customQrImageId = null");
    }
} catch (e) {
    console.error("Init error:", e.message);
}

// ═══════════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════

let isShuttingDown = false;

async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`🛑 Received ${signal}, shutting down gracefully...`);

    try {
        bot.stop(signal);
    } catch (e) {
        console.error("Bot stop error:", e.message);
    }

    try {
        updateData({ _lastShutdown: new Date().toISOString() });
        console.log("💾 Data flushed to disk");
    } catch (e) {
        console.error("Data flush error:", e.message);
    }

    console.log("✅ Shutdown complete");
    process.exit(0);
}

process.once("SIGINT", () => gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL ERROR BOUNDARIES
// ═══════════════════════════════════════════════════════════════════════════

process.on("unhandledRejection", (reason) => {
    const code = reason?.response?.error_code;
    const desc = reason?.response?.description || "";
    if (code === 403) return;
    if (code === 400 && desc.includes("query is too old")) return;
    if (code === 429) {
        console.error("⚠️ Unhandled rate limit:", desc);
        return;
    }
    console.error("❌ Unhandled Rejection:", reason?.message || reason);
    if (reason?.stack) console.error(reason.stack);
});

process.on("uncaughtException", (error) => {
    const code = error?.response?.error_code;
    if (code === 403) return;
    console.error("❌ Uncaught Exception:", error.message || error);
    if (error?.stack) console.error(error.stack);
});

// ═══════════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════════

const HEALTH_PORT = process.env.HEALTH_PORT || 0;

if (HEALTH_PORT > 0) {
    const healthServer = http.createServer((req, res) => {
        if (req.url === "/health") {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: "ok",
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                stateEntries: userStates.size,
                qrMode: getQrMode(),
                timestamp: new Date().toISOString()
            }));
        } else {
            res.writeHead(404);
            res.end("Not found");
        }
    });
    healthServer.listen(HEALTH_PORT, () => {
        console.log(`💚 Health check endpoint: http://localhost:${HEALTH_PORT}/health`);
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// START BOT
// ═══════════════════════════════════════════════════════════════════════════

let launchAttempts = 0;

async function startBot() {
    try {
        launchAttempts++;
        await bot.launch({
            dropPendingUpdates: true
        });
        console.log("✅ Bot is running!");
        launchAttempts = 0;
    } catch (error) {
        console.error(`❌ Bot launch failed (attempt ${launchAttempts}):`, error.message || error);
        const delay = Math.min(5000 * launchAttempts, 60000);
        console.log(`🔄 Retrying in ${delay / 1000}s...`);
        setTimeout(startBot, delay);
    }
}

startBot();