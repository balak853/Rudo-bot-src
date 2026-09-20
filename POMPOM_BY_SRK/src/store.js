const fs   = require("fs");
const path = require("path");
const cfg  = require("../config");

const DATA_FILE = path.resolve(__dirname, "../bot-data.json");

const defaultData = {
  adminChatId: cfg.ADMIN_CHAT_ID,
  upiId:       cfg.UPI_ID,
  upiName:     cfg.UPI_NAME,
  qrMode: "auto",
  customQrImageId: null,
  welcomeMessage:
    "🎉 *Welcome to VIP Access Bot!*\n\n" +
    "✨ Get exclusive access to premium content\n" +
    "💰 Affordable plans starting at just ₹49\n" +
    "✨ Only Premium Content\n" +
    "✨ Daily New Uploads\n\n" +
    "👇 Choose a plan to get started:",
  welcomeVideoIds: [],
  welcomeImageId: null,
  plans: [
    {
      id: "plan_1",
      name: "💦 Real Ind!an Dēsi P0rn 💋",
      price: 49,
      days: 30,
      description: "💦 Full Desi Indian content approx 40000+ videos💦\n\n💋 Buy now to get access 💋",
      groupLink: "https://t.me/+qxeNjU25N1M5ZDZl",
      demoVideos: []
    },
    {
      id: "plan_2",
      name: "🌽 CHILD CORN 🌽",
      price: 79,
      days: 30,
      description: "🌽 Premium content collection 🌽",
      groupLink: "https://t.me/+WqVMDyUYwbw1ZTJl",
      demoVideos: []
    },
    {
      id: "plan_3",
      name: "✨ G0RE R@PE ✨",
      price: 69,
      days: 30,
      description: "✨ Exclusive content ✨",
      groupLink: "https://t.me/+vs50azISYOtkNmI1",
      demoVideos: []
    },
    {
      id: "plan_4",
      name: "✨ ALL VIDEO VIP MEMBER ✨",
      price: 99,
      days: 30,
      description: "✨ All videos VIP membership ✨",
      groupLink: "https://t.me/+J9dsOp7vZmI0NDNl",
      demoVideos: []
    },
    {
      id: "plan_5",
      name: "VIP PREMIUM GROUP AND VIDEO",
      price: 149,
      days: 365,
      description: "VIP Premium Group + All Videos for 1 year!",
      groupLink: "https://t.me/+J9dsOp7vZmI0NDNl",
      demoVideos: []
    },
    {
      id: "plan_6",
      name: "BHAI BHEN HOT 😏",
      price: 89,
      days: 365,
      description: "😏 Bhai Bhen hot content 😏",
      groupLink: "https://t.me/+WqVMDyUYwbw1ZTJl",
      demoVideos: []
    },
  ],
  users:    {},
  payments: [],
};

let _data = null;
let saveTimer = null;

// ─── Debounced disk write (high-traffic safe) ───────────────────────────────
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(_data, null, 2), "utf-8");
    } catch (e) {
      console.error("Save failed", e);
    }
    saveTimer = null;
  }, 500);
}

function saveData(force = false) {
  if (force) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(_data, null, 2), "utf-8");
    } catch (e) {
      console.error("Save failed", e);
    }
    return;
  }
  scheduleSave();
}

function flushSave() {
  saveData(true);
}

// ─── Load ───────────────────────────────────────────────────────────────────
function loadData() {
  if (_data) return _data;
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));

      _data = {
        ...defaultData,
        ...parsed,
        users: parsed.users ?? {},
        payments: parsed.payments ?? [],
        welcomeVideoIds: Array.isArray(parsed.welcomeVideoIds) ? parsed.welcomeVideoIds : [],
        welcomeImageId: parsed.welcomeImageId ?? null,
        qrMode: parsed.qrMode || "auto",
        customQrImageId: parsed.customQrImageId ?? null,
        plans: (parsed.plans || []).map(p => ({
          id: p.id,
          name: p.name || "Unnamed Plan",
          price: Number(p.price) || 0,
          days: Number(p.days) || 30,
          description: p.description || "",
          groupLink: p.groupLink || "🔗 Please contact admin for group link.",
          demoVideos: Array.isArray(p.demoVideos) ? p.demoVideos : []
        }))
      };
    } else {
      _data = JSON.parse(JSON.stringify(defaultData));
      saveData(true);
    }
  } catch (error) {
    console.error("Load data error:", error);
    _data = JSON.parse(JSON.stringify(defaultData));
  }
  return _data;
}

// ─── Getters / Setters ──────────────────────────────────────────────────────
function getData() {
  if (!_data) loadData();
  return _data;
}

function updateData(updates) {
  if (!_data) loadData();
  _data = { ..._data, ...updates };
  saveData();
  return _data;
}

// ─── User tracking ──────────────────────────────────────────────────────────
function trackUser(user) {
  if (!_data) loadData();
  const key = String(user.id);
  if (!_data.users[key]) {
    _data.users[key] = {
      userId: key,
      firstName: user.first_name ?? "",
      lastName: user.last_name ?? "",
      username: user.username ?? "",
      joinedAt: new Date().toISOString()
    };
    saveData();
  }
}

// ─── Payments ───────────────────────────────────────────────────────────────
function addPayment(payment) {
  if (!_data) loadData();
  const p = {
    ...payment,
    id: `pay_${Date.now()}`,
    status: "pending",
    submittedAt: new Date().toISOString()
  };
  _data.payments.push(p);
  saveData();
  return p;
}

function updatePaymentStatus(orderId, status) {
  if (!_data) loadData();
  const p = _data.payments.find(x => x.orderId === orderId);
  if (p) {
    p.status = status;
    p.resolvedAt = new Date().toISOString();
    saveData();
  }
}

function getStats() {
  if (!_data) loadData();
  const totalUsers    = Object.keys(_data.users).length;
  const totalPayments = _data.payments.length;
  const approved      = _data.payments.filter(p => p.status === "approved").length;
  const pending       = _data.payments.filter(p => p.status === "pending").length;
  const rejected      = _data.payments.filter(p => p.status === "rejected").length;
  const totalRevenue  = _data.payments
    .filter(p => p.status === "approved")
    .reduce((s, p) => s + Number(p.amount || 0), 0);
  return { totalUsers, totalPayments, approved, pending, rejected, totalRevenue };
}

// ─── Plan management ────────────────────────────────────────────────────────
function getPlan(planId) {
  if (!_data) loadData();
  return _data.plans.find(p => p.id === planId);
}

function updatePlan(planId, updates) {
  if (!_data) loadData();
  const index = _data.plans.findIndex(p => p.id === planId);
  if (index === -1) return false;

  _data.plans[index] = { ..._data.plans[index], ...updates };
  saveData();
  return true;
}

function deletePlan(planId) {
  if (!_data) loadData();
  const index = _data.plans.findIndex(p => p.id === planId);
  if (index === -1) return false;

  _data.plans.splice(index, 1);
  saveData();
  return true;
}

function addPlan(planData) {
  if (!_data) loadData();
  const newPlan = {
    id: `plan_${Date.now()}`,
    name: planData.name,
    price: planData.price,
    days: planData.days,
    description: planData.description || "",
    groupLink: planData.groupLink || "🔗 Please contact admin for group link.",
    demoVideos: planData.demoVideos || []
  };
  _data.plans.push(newPlan);
  saveData();
  return newPlan;
}

// ─── Process exit — force flush pending writes ──────────────────────────────
process.on("SIGINT",  () => { flushSave(); });
process.on("SIGTERM", () => { flushSave(); });
process.on("exit",    () => { flushSave(); });

module.exports = {
  loadData,
  getData,
  updateData,
  trackUser,
  addPayment,
  updatePaymentStatus,
  getStats,
  getPlan,
  updatePlan,
  deletePlan,
  addPlan,
  flushSave
};