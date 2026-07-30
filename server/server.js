/**
 * باك-إند محلي لمشروع تدريبي (بدون قاعدة بيانات حقيقية).
 * يحاكي بيانات مشروع KoboToolbox من ملف kobo_data.json.
 *
 * التشغيل:  node server/server.js
 * ثم افتح:  http://localhost:3000/
 *
 * لا يعتمد على أي مكتبة خارجية — Node core فقط.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const ROOT = path.resolve(__dirname, ".."); // مجلد المشروع (sehatty-referral)
const DATA_FILE = path.join(__dirname, "kobo_data.json");
const PORT = process.env.PORT || 3000;

// ==== تحميل بيانات Kobo المحاكاة ====
function loadData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

// ==== جلسات في الذاكرة (بدل قاعدة بيانات) ====
const sessions = new Map(); // sid -> { national_id }

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx > -1) {
      out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    }
  });
  return out;
}

function getSession(req) {
  const sid = parseCookies(req).sid;
  if (sid && sessions.has(sid)) return { sid, ...sessions.get(sid) };
  return null;
}

// ==== تحويل سجل Kobo إلى الشكل الذي تنتظره الواجهة الأمامية ====
function toTransfer(rec) {
  return {
    FULL_NAME: rec.full_name,
    MOBILE_NO: rec.mobile_no,
    SPECIALIZATION: rec.specialization,
    REFERRAL_DATE: rec.referral_date,
    STATUS: rec.status,
    TRAVEL_STATUS: rec.travel_status,
    IS_STOPPED: rec.is_stopped,
    IS_REJECTED: rec.is_rejected,
    REJECTION_MESSAGES: rec.rejection_messages || [],
    RETURN_REASON: rec.return_reason,
  };
}

// ==== أدوات الرد ====
function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  }, extraHeaders || {}));
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".map": "application/json",
};

function serveStatic(req, res, urlPath) {
  // منع الخروج خارج جذر المشروع
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel.endsWith("/")) rel += "index.html";
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ==== قراءة جسم الطلب (form-urlencoded أو JSON) ====
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const ct = req.headers["content-type"] || "";
      if (ct.includes("application/json")) {
        try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); }
      } else {
        const params = new URLSearchParams(data);
        const obj = {};
        for (const [k, v] of params) obj[k] = v;
        resolve(obj);
      }
    });
  });
}

// ==== المسارات ====
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsed.pathname;

  // --- POST /citizen/login : التحقق من الهوية وكلمة المرور مقابل بيانات Kobo ---
  if (req.method === "POST" && pathname === "/citizen/login") {
    const body = await readBody(req);
    const nationalId = (body.national_id || "").trim();
    const password = (body.password || "").trim();
    const data = loadData();

    const user = data.submissions.find(
      (s) => String(s.national_id) === nationalId && String(s.password) === password
    );

    if (!user) {
      return sendJson(res, 401, { message: "رقم الهوية أو كلمة المرور غير صحيحة" });
    }

    // إنشاء جلسة
    const sid = crypto.randomBytes(16).toString("hex");
    sessions.set(sid, { national_id: String(user.national_id) });

    return sendJson(res, 200, { redirect: "/citizen/citizen/referral/" }, {
      "Set-Cookie": `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`,
    });
  }

  // --- GET /citizen/logout ---
  if (req.method === "GET" && pathname === "/citizen/logout") {
    const sess = getSession(req);
    if (sess) sessions.delete(sess.sid);
    res.writeHead(302, {
      Location: "/citizen/login/",
      "Set-Cookie": "sid=; Path=/; Max-Age=0",
    });
    return res.end();
  }

  // --- GET /citizen/result : بيانات التحويلة للمستخدم الحالي (حسب الجلسة) ---
  if (req.method === "GET" && pathname === "/citizen/result") {
    const sess = getSession(req);
    if (!sess) return sendJson(res, 200, { success: 0, transfers: [] });

    const data = loadData();
    const transfers = data.submissions
      .filter((s) => String(s.national_id) === sess.national_id)
      .map(toTransfer);

    return sendJson(res, 200, { success: 1, transfers });
  }

  // --- GET /admin/patient-referral-profile : إحصائيات عامة ---
  if (req.method === "GET" && pathname === "/admin/patient-referral-profile") {
    const data = loadData();
    return sendJson(res, 200, { stats: data.global_stats });
  }

  // --- حماية صفحة التحويلات: لا دخول بدون جلسة ---
  if (
    req.method === "GET" &&
    (pathname === "/citizen/citizen/referral" || pathname === "/citizen/citizen/referral/")
  ) {
    if (!getSession(req)) return redirect(res, "/citizen/login/");
    return serveStatic(req, res, "/citizen/citizen/referral/index.html");
  }

  // --- ملفات ثابتة (الصفحة الرئيسية، صفحة الدخول، assets ...) ---
  if (req.method === "GET") {
    return serveStatic(req, res, pathname);
  }

  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method Not Allowed");
});

server.listen(PORT, () => {
  console.log("======================================================");
  console.log(" باك-إند تدريبي (محاكاة Kobo) يعمل الآن");
  console.log(` الصفحة الرئيسية : http://localhost:${PORT}/`);
  console.log(` تسجيل الدخول    : http://localhost:${PORT}/citizen/login/`);
  console.log("------------------------------------------------------");
  console.log(" حسابات تجريبية (كلمة المرور للجميع: 1234):");
  loadData().submissions.forEach((s) => {
    console.log(`   ${s.national_id}  =>  ${s.full_name}  (${s.status})`);
  });
  console.log("======================================================");
});
