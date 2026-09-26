#!/usr/bin/env python3
"""Login to Xiaomi passport via a real browser, harvest Mimo cookies, import them.

HTTP serviceLoginAuth2 is blocked by Xiaomi risk control (code 70016) from
datacenter IPs. Driving the installed Chrome through the official FE login
presents a real fingerprint; captcha/identity verification and password fixes
can be completed by a human when --allow-human is set.

On success the three cookies are PUT to Chat2API management API
(POST/PUT /v0/management/accounts) unless --no-import is given.

Prints one JSON line on stdout:
  {"kind":"ok","service_token":"...","user_id":"...","ph_token":"...",...}
  {"kind":"error","message":"..."}

Geetest slide captcha is auto-solved when bg/slice images are extractable
(same gap-drag pattern as scripts/zai-captcha/solve.py); otherwise the open
browser waits for a human (--allow-human).
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import random
import re
import subprocess
import sys
import time

from patchright.sync_api import sync_playwright

MIMO_HOME = "https://aistudio.xiaomimimo.com/"
MIMO_HOME_APP = "https://aistudio.xiaomimimo.com/#/c"
XIAOMI_LOGIN = "https://account.xiaomi.com/fe/service/login/password?_locale=en_US"
PASSPORT_LOGIN = (
    "https://account.xiaomi.com/fe/service/login"
    "?sid=xiaomichatbot"
    "&callback=https%3A%2F%2Faistudio.xiaomimimo.com%2Fsts"
    "&_json=true"
    "&_locale=zh_CN"
)
MIMO_LOGIN_SELECTORS = [
    "button:has-text('Sign in')",
    "a:has-text('Sign in')",
    "button:has-text('Log in')",
    "button:has-text('Login')",
    "button:has-text('登录')",
    "a:has-text('登录')",
    "button:has-text('立即登录')",
    "a:has-text('立即登录')",
]
def _default_gmail_helper() -> str:
    """Locate the Maton Gmail helper without baking in a machine-specific path."""
    roots = [
        os.environ.get("CODEX_HOME", ""),
        os.path.join(os.path.expanduser("~"), ".codex"),
    ]
    for root in roots:
        if not root:
            continue
        candidate = os.path.join(root, "skills", "gmail", "scripts", "maton_gmail.py")
        if os.path.isfile(candidate):
            return candidate
    return ""


GMAIL_HELPER = os.environ.get("MIMO_GMAIL_HELPER", "").strip() or _default_gmail_helper()

# Populated from Geetest gt/load + image responses (canvas is often tainted).
GEETEST_ASSETS: dict = {
    "bg_path": "",
    "slice_path": "",
    "ypos": None,
    "bg_bytes": None,
    "slice_bytes": None,
    "static_base": "",
}


def _capture_geetest_assets(resp) -> None:
    u = resp.url or ""
    interesting = (
        "gt/load" in u
        or "getCode" in u
        or "v4_pic" in u
        or "/bg/" in u
        or "/slice/" in u
        or "captcha" in u and (u.endswith(".png") or ".png?" in u)
    )
    if not interesting:
        return
    try:
        ctype = (resp.headers or {}).get("content-type", "") or ""
        if "image" in ctype or (u.split("?")[0].endswith(".png") and "gt/load" not in u):
            body = resp.body()
            if body and len(body) > 100:
                if "/bg/" in u or "bg/" in u.split("/")[-2:]:
                    GEETEST_ASSETS["bg_bytes"] = body
                if "/slice/" in u or "slice/" in u.split("/")[-2:]:
                    GEETEST_ASSETS["slice_bytes"] = body
                log(f"[mimo-login] geetest image captured {len(body)}B {u[:120]}")
            return
        if "gt/load" in u or "getCode" in u:
            body_bytes = resp.body() or b""
            if not body_bytes:
                return
            ctype_lower = ctype.lower()
            textish = any(token in ctype_lower for token in ("json", "text", "javascript", "xml"))
            if not textish and body_bytes[:1] in (b"\xff", b"\x89", b"\x1f", b"\x00"):
                if "bg" in u:
                    GEETEST_ASSETS["bg_bytes"] = body_bytes
                if "slice" in u:
                    GEETEST_ASSETS["slice_bytes"] = body_bytes
                return
            raw = body_bytes.decode("utf-8", errors="ignore")
            m = re.search(r"\((\{.*\})\)", raw, re.S)
            payload = json.loads(m.group(1) if m else raw)
            data = payload.get("data") or payload
            bg = str(data.get("bg") or "")
            sl = str(data.get("slice") or "")
            # New puzzle invalidates previously cached pixels.
            if bg and bg != GEETEST_ASSETS.get("bg_path"):
                GEETEST_ASSETS["bg_bytes"] = None
                GEETEST_ASSETS["slice_bytes"] = None
            if bg:
                GEETEST_ASSETS["bg_path"] = bg
            if sl:
                GEETEST_ASSETS["slice_path"] = sl
            if data.get("ypos") is not None:
                GEETEST_ASSETS["ypos"] = data.get("ypos")
            log(
                f"[mimo-login] geetest load bg={bg[:80]!r} slice={sl[:80]!r} "
                f"ypos={GEETEST_ASSETS['ypos']}"
            )
            # Prefer absolute CDN base when the path is relative.
            if bg and not bg.startswith("http"):
                for base in (
                    "https://captcha-tp-cdn01.infosec.xiaomi.com/",
                    "https://static-verify.infosec.xiaomi.com/",
                    "https://verify.infosec.xiaomi.com/",
                ):
                    GEETEST_ASSETS["static_base"] = base
                    break
    except Exception as exc:
        log(f"[mimo-login] geetest asset capture failed: {exc}")


def _geetest_asset_urls() -> list[str]:
    urls: list[str] = []
    for key in ("bg_path", "slice_path"):
        path = GEETEST_ASSETS.get(key) or ""
        if not path:
            continue
        if path.startswith("http"):
            urls.append(path)
        else:
            for base in (
                GEETEST_ASSETS.get("static_base") or "",
                "https://captcha-tp-cdn01.infosec.xiaomi.com/",
                "https://static-verify.infosec.xiaomi.com/",
                "https://verify.infosec.xiaomi.com/",
            ):
                if base:
                    urls.append(base + path.lstrip("/"))
    return urls


def _fetch_geetest_network_assets(page) -> tuple[bytes | None, bytes | None]:
    """Download bg/slice from captured gt/load paths when canvas extraction fails."""
    bg = GEETEST_ASSETS.get("bg_bytes")
    sl = GEETEST_ASSETS.get("slice_bytes")
    if bg and sl:
        return bg, sl
    bg_path = GEETEST_ASSETS.get("bg_path") or ""
    sl_path = GEETEST_ASSETS.get("slice_path") or ""
    bases = []
    if GEETEST_ASSETS.get("static_base"):
        bases.append(GEETEST_ASSETS["static_base"])
    bases.extend((
        "https://captcha-tp-cdn01.infosec.xiaomi.com/",
        "https://static-verify.infosec.xiaomi.com/",
        "https://verify.infosec.xiaomi.com/",
    ))
    jobs: list[tuple[str, str]] = []
    for kind, path in (("bg", bg_path), ("slice", sl_path)):
        if not path:
            continue
        if path.startswith("http"):
            jobs.append((kind, path))
        else:
            for base in bases:
                jobs.append((kind, base + path.lstrip("/")))
    for kind, url in jobs:
        try:
            resp = page.context.request.get(url, timeout=10000)
            if not resp.ok:
                continue
            body = resp.body()
            if not body or len(body) < 100:
                continue
            if kind == "bg" and not GEETEST_ASSETS.get("bg_bytes"):
                GEETEST_ASSETS["bg_bytes"] = body
                bg = body
            if kind == "slice" and not GEETEST_ASSETS.get("slice_bytes"):
                GEETEST_ASSETS["slice_bytes"] = body
                sl = body
            log(f"[mimo-login] geetest fetch {kind} {len(body)}B {url[:140]}")
            if bg and sl:
                break
        except Exception as exc:
            log(f"[mimo-login] geetest fetch failed {kind} {url[:90]}: {exc}")
    return bg, sl


def parse_args():
    p = argparse.ArgumentParser(description="Mimo Xiaomi passport browser login")
    p.add_argument("--email", required=True)
    p.add_argument("--password", required=True)
    p.add_argument("--headless", action="store_true")
    p.add_argument("--wait-seconds", type=int, default=60)
    p.add_argument("--allow-human", action="store_true")
    p.add_argument("--human-timeout", type=int, default=420)
    p.add_argument("--artifact-dir", default=os.environ.get(
        "MIMO_LOGIN_ARTIFACT_DIR",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "artifacts"),
    ))
    p.add_argument("--account-id", default="")
    p.add_argument("--account-name", default="")
    p.add_argument("--management-url", default="http://127.0.0.1:8080")
    p.add_argument("--management-secret", default=os.environ.get("CHAT2API_MANAGEMENT_SECRET", ""))
    p.add_argument("--no-import", action="store_true",
                   help="Harvest cookies only; do not PUT them to the management API")
    p.add_argument("--email-code", default=os.environ.get("MIMO_EMAIL_CODE", ""),
                   help="Optional email verification code to fill automatically")
    p.add_argument("--gmail-code", action="store_true", default=True,
                   help="Fetch Xiaomi verification code from Gmail (default on)")
    p.add_argument("--no-gmail-code", dest="gmail_code", action="store_false",
                   help="Disable Gmail auto code fetch")
    return p.parse_args()


def _gmail_cli(*args: str) -> dict:
    if not GMAIL_HELPER or not os.path.isfile(GMAIL_HELPER):
        raise FileNotFoundError(GMAIL_HELPER or "MIMO_GMAIL_HELPER is not set")
    proc = subprocess.run(
        [sys.executable, GMAIL_HELPER, *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "gmail helper failed")
    return json.loads(proc.stdout or "{}")


def load_gmail_config(args) -> dict | None:
    """Pull gmailConfig from the management API (Settings → Gmail OTP)."""
    try:
        status, payload = management_request(args, "GET", "/v0/management/gmail/config")
        if status != 200:
            return None
        cfg = payload.get("data") or {}
        if not isinstance(cfg, dict):
            return None
        return cfg
    except Exception as exc:
        log(f"[mimo-login] gmail config load failed: {exc}")
        return None


def fetch_gmail_email_code_managed(args, to_email: str, via_code_api: bool = True) -> str:
    """Prefer the service /gmail/code endpoint; fall back to local helper."""
    if via_code_api:
        try:
            status, payload = management_request(
                args,
                "POST",
                "/v0/management/gmail/code",
                {"email": to_email, "sinceMs": int(time.time() * 1000) - 15 * 60 * 1000},
            )
            if status == 200:
                code = str((payload.get("data") or {}).get("code") or "").strip()
                if code:
                    return code
            else:
                log(f"[mimo-login] gmail code api HTTP {status}")
        except Exception as exc:
            log(f"[mimo-login] gmail code api failed: {exc}")
    return ""


def click_first(page, selectors) -> bool:
    for selector in selectors:
        try:
            loc = page.locator(selector).first
            if loc.count() and loc.is_visible(timeout=400):
                try:
                    loc.click(timeout=2500)
                    return True
                except Exception:
                    try:
                        loc.click(timeout=1500, force=True)
                        return True
                    except Exception:
                        try:
                            loc.evaluate("el => el.click()")
                            return True
                        except Exception:
                            continue
        except Exception:
            continue
    return False


def wait_for_login_form(page, timeout_s: float = 12.0) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            email_candidates = [
                page.locator("input[name='account']").first,
                page.locator("input[name='user']").first,
                page.locator("input[type='email']").first,
                page.locator("input[type='text']").first,
            ]
            password_candidates = [
                page.locator("input[name='password']").first,
                page.locator("input[type='password']").first,
            ]
            for email_loc in email_candidates:
                if not email_loc.count() or not email_loc.is_visible(timeout=200):
                    continue
                for pass_loc in password_candidates:
                    if pass_loc.count() and pass_loc.is_visible(timeout=200):
                        return True
        except Exception:
            pass
        page.wait_for_timeout(400)
    return False


def enter_login_via_mimo(context, page) -> bool:
    """Skill entry: open MiMo #/c, click Sign in so SSO carries service context.

    Returns True when a password form is visible. If a new tab opens, the
    returned page is already switched via context.pages[-1]; callers must
    re-assign `page` from `pick_page(context, page)` when needed.
    """
    try:
        page.goto(MIMO_HOME_APP, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(2500)
        if wait_for_login_form(page, timeout_s=4):
            return True
        if click_first(page, MIMO_LOGIN_SELECTORS):
            log("[mimo-login] mimo Sign in entry clicked")
            page.wait_for_timeout(3000)
            if len(context.pages) > 1:
                # Prefer the newest tab that shows a form.
                for cand in reversed(context.pages):
                    if wait_for_login_form(cand, timeout_s=1):
                        return True
            if wait_for_login_form(page, timeout_s=8):
                return True
    except Exception as exc:
        log(f"[mimo-login] mimo entry failed: {exc}")

    try:
        page.goto(XIAOMI_LOGIN, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(1500)
        if wait_for_login_form(page, timeout_s=8):
            return True
    except Exception as exc:
        log(f"[mimo-login] xiaomi login fallback failed: {exc}")

    try:
        page.goto(PASSPORT_LOGIN, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(1500)
        return wait_for_login_form(page, timeout_s=8)
    except Exception as exc:
        log(f"[mimo-login] passport fallback failed: {exc}")
        return False


def pick_page(context, preferred):
    """Return preferred if it still has a form, else the newest form-bearing tab."""
    try:
        if wait_for_login_form(preferred, timeout_s=0.5):
            return preferred
    except Exception:
        pass
    for cand in reversed(list(context.pages)):
        try:
            if wait_for_login_form(cand, timeout_s=0.5):
                return cand
        except Exception:
            continue
    return preferred


def ensure_mimo_cookies(context, page, timeout_s: int = 45) -> dict:
    """After authed, land on MiMo and re-click Sign in until service cookies exist."""
    deadline = time.time() + timeout_s
    last_names: list[str] | None = None
    while time.time() < deadline:
        jar = harvest(context)
        if complete_cookies(jar):
            return visit_home(context, page)
        names = jar.get("cookie_names", [])
        if names != last_names:
            log(f"[mimo-login] cookies seen: {names[:24]}")
            last_names = names
        url = (page.url or "").lower()
        if "aistudio.xiaomimimo.com" not in url:
            try:
                page.goto(MIMO_HOME_APP, wait_until="domcontentloaded", timeout=45000)
                page.wait_for_timeout(3000)
            except Exception:
                time.sleep(2)
            continue
        if click_first(page, MIMO_LOGIN_SELECTORS):
            log("[mimo-login] ensure cookies: Sign in re-clicked")
            page.wait_for_timeout(4000)
            continue
        page.wait_for_timeout(2000)
    return harvest(context)


def _decode_message_text(message: dict) -> str:
    parts = [str(message.get("snippet") or "")]
    payload = message.get("payload") or {}

    def walk(node: dict) -> None:
        data = (node.get("body") or {}).get("data") or ""
        if data:
            try:
                raw = base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))
                parts.append(raw.decode("utf-8", errors="replace"))
            except Exception:
                pass
        for child in node.get("parts") or []:
            walk(child)

    walk(payload)
    return "\n".join(parts)


def extract_email_code(text: str) -> str:
    patterns = (
        r"验证码[是为:：\s]*([0-9]{6})",
        r"verification code is[:\s]*([0-9]{6})",
        r"code is[:\s]*([0-9]{6})",
        r"\b([0-9]{6})\b",
    )
    for pat in patterns:
        m = re.search(pat, text, flags=re.I)
        if m:
            return m.group(1)
    return ""


def fetch_gmail_email_code(to_email: str, since_ms: int, args=None) -> str:
    """Return the newest Xiaomi 6-digit code delivered to to_email after since_ms.

    Prefer the Chat2API management endpoint (Settings → Gmail OTP); fall back to
    the local Maton helper script when the service is unavailable.
    """
    if args is not None:
        managed = fetch_gmail_email_code_managed(args, to_email, via_code_api=True)
        if managed:
            return managed

    query = (
        f"from:(notice.xiaomi.com OR xiaomi.com) "
        f"to:{to_email} newer_than:15m"
    )
    listed = _gmail_cli(
        "list-messages",
        "--max-results", "8",
        "--query", query,
        "--include-spam-trash",
    )
    best_code = ""
    best_ts = 0
    for item in listed.get("messages") or []:
        msg_id = str(item.get("id") or "")
        if not msg_id:
            continue
        try:
            message = _gmail_cli("get-message", msg_id, "--format", "full")
        except Exception:
            continue
        ts = int(message.get("internalDate") or 0)
        if ts < since_ms:
            continue
        to_headers = [
            str(h.get("value") or "")
            for h in ((message.get("payload") or {}).get("headers") or [])
            if str(h.get("name") or "").lower() == "to"
        ]
        joined = " ".join(to_headers).lower()
        if to_email.lower() not in joined and "xiaomi" not in (message.get("snippet") or "").lower():
            # Still allow if body clearly Xiaomi verification for this mailbox.
            body = _decode_message_text(message)
            if to_email.lower() not in body.lower() and "小米" not in body and "xiaomi" not in body.lower():
                continue
        code = extract_email_code(_decode_message_text(message))
        if code and ts >= best_ts:
            best_code = code
            best_ts = ts
    return best_code


def emit(payload: dict) -> None:
    line = json.dumps(payload, ensure_ascii=False)
    # Windows consoles often default to GBK; keep one JSON line intact.
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        sys.stdout.buffer.write((line + "\n").encode("utf-8", errors="replace"))
        sys.stdout.buffer.flush()


def log(msg: str) -> None:
    try:
        print(msg, file=sys.stderr, flush=True)
    except UnicodeEncodeError:
        sys.stderr.buffer.write((msg + "\n").encode("utf-8", errors="replace"))
        sys.stderr.buffer.flush()


def chrome_path() -> str:
    for candidate in [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ]:
        if os.path.isfile(candidate):
            return candidate
    return ""


def launch(pw, headless: bool):
    path = chrome_path()
    kwargs = {"headless": headless, "args": ["--no-sandbox", "--disable-dev-shm-usage"]}
    if path and os.path.basename(path).lower().startswith("chrome"):
        kwargs["channel"] = "chrome"
    elif path:
        kwargs["executable_path"] = path
    browser = pw.chromium.launch(**kwargs)
    context = browser.new_context(
        locale="zh-CN",
        timezone_id="Asia/Shanghai",
        viewport={"width": 1280, "height": 900},
    )
    return browser, context


def harvest(context) -> dict:
    cookies = context.cookies()
    jar: dict[str, str] = {}
    for c in cookies:
        name = c.get("name") or ""
        value = c.get("value") or ""
        domain = c.get("domain") or ""
        if not name or not value or value.upper() == "EXPIRED":
            continue
        # Prefer aistudio-scoped cookies when both exist
        if name in ("serviceToken", "xiaomichatbot_serviceToken"):
            if "xiaomimimo" in domain or name.startswith("xiaomichatbot") or name not in jar:
                jar[name] = value
        elif name in ("userId", "cUserId"):
            if "xiaomimimo" in domain or name not in jar:
                jar[name] = value
        elif name == "xiaomichatbot_ph":
            jar[name] = value
        else:
            jar.setdefault(name, value)

    service = jar.get("xiaomichatbot_serviceToken") or jar.get("serviceToken") or ""
    user = jar.get("userId") or jar.get("cUserId") or ""
    ph = jar.get("xiaomichatbot_ph") or ""
    return {
        "service_token": service,
        "user_id": user,
        "ph_token": ph,
        "cookie_names": sorted(jar.keys()),
    }


def now_shot_due(last: float) -> bool:
    return (time.time() - last) >= 15


def save_screenshot(page, artifact_dir: str, name: str) -> None:
    try:
        os.makedirs(artifact_dir, exist_ok=True)
        page.screenshot(path=os.path.join(artifact_dir, name), full_page=True)
    except Exception:
        pass


def page_text(page) -> str:
    try:
        return page.inner_text("body") or ""
    except Exception:
        return ""


def dismiss_cookie_banner(page) -> None:
    for label in ("同意并关闭提示", "同意", "接受", "I agree", "Accept"):
        try:
            loc = page.get_by_role("button", name=label).first
            if loc.count() and loc.is_visible(timeout=300):
                loc.click(timeout=1000)
                page.wait_for_timeout(300)
                return
        except Exception:
            continue


def accept_agreement_modal(page) -> bool:
    """Click 同意并继续 / Agree on Xiaomi's post-submit agreement tip dialog."""
    selectors = (
        "button:has-text('同意并继续')",
        "button:has-text('同意并繼續')",
        "button:has-text('Agree and continue')",
        "button:has-text('Agree')",
        "button:has-text('同意')",
        "[role='button']:has-text('Agree')",
        "[role='button']:has-text('同意')",
    )
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            if loc.count() and loc.is_visible(timeout=200):
                label = ""
                try:
                    label = (loc.inner_text(timeout=200) or "").strip().lower()
                except Exception:
                    pass
                if "cancel" in label or "取消" in label:
                    continue
                loc.click(timeout=2000, force=True)
                page.wait_for_timeout(500)
                log(f"[mimo-login] agreement modal clicked ({label or sel})")
                return True
        except Exception:
            continue
    # Modal body text as a weaker signal — click the primary orange button.
    try:
        if (
            page.locator("text=已阅读并同意").count()
            or page.locator("text=I've read and agreed").count()
            or page.locator("text=Attention").count()
        ):
            for sel in (
                "button.btn-primary",
                "button.primary",
                "button.orange",
                "button:has-text('Agree')",
                "button:has-text('同意')",
            ):
                primary = page.locator(sel).first
                if primary.count() and primary.is_visible(timeout=200):
                    primary.click(timeout=2000, force=True)
                    page.wait_for_timeout(500)
                    log(f"[mimo-login] agreement modal primary clicked ({sel})")
                    return True
    except Exception:
        pass
    return False


def agreement_modal_visible(page) -> bool:
    try:
        return bool(
            page.locator("text=已阅读并同意").count()
            or page.locator("text=友情提示").count()
            or page.locator("button:has-text('同意并继续')").count()
            or page.locator("text=I've read and agreed").count()
            or page.locator("text=Attention").count()
            or page.locator("button:has-text('Agree')").count()
        )
    except Exception:
        return False


def email_verification_visible(page) -> bool:
    """Xiaomi passport 邮箱安全验证（verifyEmail / 发送邮件 / Send email / Send）页面。"""
    try:
        if email_code_input_visible(page):
            return False
        url = page.url or ""
        try:
            send_btn = (
                page.get_by_role("button", name="发送邮件", exact=True).first.count()
                or page.get_by_role("button", name="发送郵件", exact=True).first.count()
                or page.get_by_role("button", name="Send email", exact=True).first.count()
                or page.get_by_role("button", name="Send Email", exact=True).first.count()
                or page.get_by_role("button", name="Send", exact=True).first.count()
                or page.locator("button:text-is('发送邮件')").count()
                or page.locator("button:text-is('Send email')").count()
                or page.locator("button:text-is('Send')").count()
            )
        except Exception:
            send_btn = 0
        if "verify.infosec.xiaomi.com" in url or "verifyEmail" in url:
            return bool(send_btn)
        text = page_text(page)
        lowered = text.lower()
        return any(m in text for m in (
            "小米账号安全验证",
            "验证您的安全邮箱",
            "有验证码的邮件",
            "Send verification code",
            "Account Authentication",
        )) or any(m in lowered for m in (
            "verify your security email",
            "security email",
            "verify your identity",
            "send verification code",
        )) or bool(send_btn)
    except Exception:
        return False


def start_email_verification(page) -> bool:
    """Click 发送邮件 / Send so Xiaomi emails a one-time code to the recovery address."""
    candidates = []
    try:
        candidates.append(page.get_by_role("button", name="发送邮件", exact=True).first)
        candidates.append(page.get_by_role("button", name="发送郵件", exact=True).first)
        candidates.append(page.get_by_role("button", name="Send email", exact=True).first)
        candidates.append(page.get_by_role("button", name="Send Email", exact=True).first)
        candidates.append(page.get_by_role("button", name="Send", exact=True).first)
    except Exception:
        pass
    for sel in (
        "button:text-is('发送邮件')",
        "button:text-is('发送郵件')",
        "button:text-is('Send email')",
        "button:text-is('Send Email')",
        "button:text-is('Send')",
        "button:has-text('发送邮件')",
        "button:has-text('Send email')",
        "[role='button']:text-is('Send')",
        "button.btn-primary:has-text('Send')",
        "button.primary:has-text('Send')",
    ):
        try:
            candidates.append(page.locator(sel).first)
        except Exception:
            continue
    for loc in candidates:
        try:
            if loc.count() and loc.is_visible(timeout=500):
                loc.click(timeout=3000, force=True)
                page.wait_for_timeout(1500)
                log("[mimo-login] clicked 发送邮件/Send — waiting for code input")
                # Wait briefly for the code input to replace the send button.
                appeared = False
                try:
                    page.wait_for_function(
                        """() => {
                          const inputs = document.querySelectorAll('input');
                          for (const el of inputs) {
                            const ph = ((el.getAttribute('placeholder') || '') +
                              (el.getAttribute('maxlength') || '') +
                              (el.getAttribute('aria-label') || '') +
                              (el.getAttribute('name') || '')).toLowerCase();
                            if (ph.includes('验证码') || ph.includes('verification') ||
                                ph.includes('code') || el.getAttribute('maxlength') === '6') return true;
                          }
                          return false;
                        }""",
                        timeout=8000,
                    )
                    appeared = True
                except Exception:
                    appeared = False
                if not appeared:
                    # Log what the page actually looks like for debugging.
                    try:
                        inputs = page.eval_on_selector_all(
                            "input",
                            """els => els.map(e => ({
                                type: e.type, name: e.name, maxlength: e.maxLength,
                                placeholder: e.placeholder, visible: !!(e.offsetWidth || e.offsetHeight)
                            }))""",
                        )
                        log(f"[mimo-login] after send, inputs={inputs}")
                        default_dir = os.path.join(
                            os.path.dirname(os.path.abspath(__file__)), "artifacts"
                        )
                        save_screenshot(
                            page,
                            os.environ.get("MIMO_LOGIN_ARTIFACT_DIR", default_dir),
                            "after-send.png",
                        )
                    except Exception as exc:
                        log(f"[mimo-login] after-send debug failed: {exc}")
                return True
        except Exception:
            continue
    return False


def email_code_input(page):
    for sel in (
        "input[placeholder*='验证码']",
        "input[placeholder*='verification']",
        "input[placeholder*='Verification']",
        "input[placeholder*='code']",
        "input[placeholder*='Code']",
        "input[maxlength='6']",
        "input[inputmode='numeric']",
        "input[name*='code']",
        "input[name*='verify']",
        "input[autocomplete='one-time-code']",
    ):
        try:
            loc = page.locator(sel).first
            if loc.count() and loc.is_visible(timeout=200):
                return loc
        except Exception:
            continue
    return None


def email_code_input_visible(page) -> bool:
    try:
        if email_code_input(page) is not None:
            url = (page.url or "").lower()
            # OTP field only counts on identity/verify surfaces, not account chrome.
            if any(s in url for s in ("identity", "verify", "verifyemail", "auth")):
                return True
            text_l = page_text(page).lower()
            if "verification code" in text_l or "验证码" in text_l:
                return True
            return False
        text = page_text(page)
        lowered = text.lower()
        return (
            "请输入邮件验证码" in text
            or "请输入验证码" in text
            or "enter the verification code" in lowered
            or "enter verification code" in lowered
            or ("verification code" in lowered and "sent" in lowered)
        )
    except Exception:
        return False


def fill_email_code(page, code: str) -> bool:
    loc = email_code_input(page)
    if loc is None:
        return False
    try:
        loc.fill(code.strip(), timeout=3000, force=True)
        page.wait_for_timeout(300)
        for sel in (
            "button:has-text('确定')",
            "button:has-text('继续')",
            "button:has-text('Submit')",
            "button:has-text('Continue')",
            "button:has-text('Next')",
            "button[type='submit']",
        ):
            btn = page.locator(sel).first
            if btn.count() and btn.is_visible(timeout=300):
                btn.click(timeout=2000, force=True)
                page.wait_for_timeout(800)
                return True
        loc.press("Enter")
        page.wait_for_timeout(800)
        return True
    except Exception:
        return False


def geetest_visible(page) -> bool:
    """Geetest slide captcha usually lives in an iframe — scan frames too."""
    try:
        for frame in page.frames:
            try:
                furl = (frame.url or "").lower()
                if "verify.infosec.xiaomi.com" in furl or "geetest" in furl:
                    if frame.locator(".geetest_panel, .geetest_slider, .geetest_btn").first.count():
                        return True
                html = ""
                try:
                    html = (frame.content() or "")[:8000].lower()
                except Exception:
                    continue
                if "geetest" in html or "gt_slider" in html or "geetest_slider" in html:
                    return True
            except Exception:
                continue
        # Fallback: main-frame selectors / overlays.
        for sel in (
            ".geetest_panel",
            ".geetest_slider",
            ".geetest_btn",
            "div[class*='geetest']",
            "iframe[src*='verify.infosec']",
            "iframe[src*='geetest']",
        ):
            try:
                if page.locator(sel).first.count():
                    return True
            except Exception:
                continue
        url = (page.url or "").lower()
        if "verify.infosec.xiaomi.com" in url and "captcha" in url:
            return True
    except Exception:
        return False
    return False


def geetest_frame(page):
    try:
        for frame in page.frames:
            try:
                if frame.locator(".geetest_btn, .geetest_slider, .geetest_panel").first.count():
                    return frame
            except Exception:
                continue
    except Exception:
        pass
    return page


def _decode_data_image(source: str) -> bytes:
    if "," not in source:
        raise RuntimeError("Not a data URL")
    return base64.b64decode(source.split(",", 1)[1])


def _locator_image_bytes(page, frame, selectors) -> bytes | None:
    errors: list[str] = []
    for sel in selectors:
        candidates = [sel]
        # Wrappers (.geetest_canvas_bg) hold canvas/img children.
        candidates.extend((f"{sel} canvas", f"{sel} img"))
        for candidate in candidates:
            try:
                loc = frame.locator(candidate).first
                if not loc.count():
                    continue
                result = loc.evaluate("""async image => {
                    const el = image;
                    let width = el.naturalWidth || el.width || 0;
                    let height = el.naturalHeight || el.height || 0;
                    if ((!width || !height) && el.tagName === 'CANVAS') {
                        width = el.width; height = el.height;
                    }
                    if ((!width || !height) && el.tagName !== 'CANVAS') {
                        const child = el.querySelector('canvas, img');
                        if (child) {
                            width = child.naturalWidth || child.width || 0;
                            height = child.naturalHeight || child.height || 0;
                        }
                    }
                    const src = el.currentSrc || el.src || (el.querySelector && el.querySelector('img') && el.querySelector('img').currentSrc) || '';
                    const errors = [];
                    if (!width || !height) errors.push('zero-size');
                    const encode = drawable => {
                        const canvas = document.createElement('canvas');
                        canvas.width = width; canvas.height = height;
                        const ctx = canvas.getContext('2d', {willReadFrequently: true});
                        if (!ctx) throw new Error('no canvas');
                        ctx.drawImage(drawable, 0, 0, width, height);
                        return canvas.toDataURL('image/png');
                    };
                    const target = (el.tagName === 'CANVAS' || el.tagName === 'IMG') ? el
                        : (el.querySelector && (el.querySelector('canvas') || el.querySelector('img')));
                    if (target && width && height) {
                        try { return {dataUrl: encode(target), src: target.currentSrc || target.src || src, errors}; }
                        catch (error) { errors.push('canvas: ' + String(error)); }
                    }
                    if (src) {
                        for (const options of [{credentials: 'include', mode: 'cors'}, undefined]) {
                            try {
                                const response = options ? await fetch(src, options) : await fetch(src);
                                if (!response.ok) throw new Error('HTTP ' + response.status);
                                const bitmap = await createImageBitmap(await response.blob());
                                return {dataUrl: encode(bitmap), src, errors};
                            } catch (error) {
                                errors.push('fetch: ' + String(error));
                            }
                        }
                        return {dataUrl: null, src, errors};
                    }
                    return {dataUrl: null, src, errors};
                }""")
                if not isinstance(result, dict):
                    errors.append(f"{candidate}: non-dict {result!r}")
                    continue
                errors.extend(f"{candidate}: {e}" for e in (result.get("errors") or []))
                data_url = result.get("dataUrl")
                if data_url:
                    return _decode_data_image(data_url)
                src = result.get("src") or ""
                if src.startswith("http"):
                    resp = page.context.request.get(src, timeout=8000)
                    if resp.ok:
                        return resp.body()
            except Exception as exc:
                errors.append(f"{candidate}: {exc}")
    if errors:
        log(f"[mimo-login] image extract fail: {'; '.join(errors[:6])}")
    return None


def geetest_images_ready(frame, timeout_s: float = 6.0) -> bool:
    deadline = time.time() + timeout_s
    bg_sels = (
        ".geetest_canvas_bg",
        ".geetest_bg",
        ".geetest_pic",
        ".geetest_picture",
        "canvas[id*='bg']",
        "img[class*='bg']",
    )
    slice_sels = (
        ".geetest_canvas_slice",
        ".geetest_slice",
        ".geetest_block",
        ".geetest_pic_slice",
        "canvas[id*='slice']",
        "img[class*='slice']",
    )
    while time.time() < deadline:
        try:
            bg_ok = any(frame.locator(s).first.count() for s in bg_sels)
            sl_ok = any(frame.locator(s).first.count() for s in slice_sels)
            if bg_ok and sl_ok:
                return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


def _geetest_hole_x(bg_u8, piece_rgba, ypos: int | None = None) -> tuple[int, int]:
    """Return (hole_left_x_in_bg_px, piece_left_x_in_slice_px)."""
    import numpy as np

    try:
        import cv2
    except Exception:
        cv2 = None

    mask = piece_rgba[:, :, 3] > 24
    if mask.sum() < 80:
        raise RuntimeError("empty piece mask")
    ay, ax = np.where(mask)
    y0, y1 = int(ay.min()), int(ay.max()) + 1
    x0, x1 = int(ax.min()), int(ax.max()) + 1
    shape = mask[y0:y1, x0:x1]
    span = shape.shape[1]
    patch_h = shape.shape[0]
    if span < 8 or bg_u8.shape[1] <= span + 2:
        raise RuntimeError("piece/bg size mismatch")

    # Geetest ypos is the piece's vertical origin inside the background.
    # Prefer it over the slice's own alpha rows when provided.
    if ypos is not None and ypos >= 0 and ypos + shape.shape[0] <= bg_u8.shape[0]:
        row0 = int(ypos)
    else:
        row0 = min(y0, max(0, bg_u8.shape[0] - shape.shape[0]))
    if row0 + shape.shape[0] > bg_u8.shape[0]:
        row0 = max(0, bg_u8.shape[0] - shape.shape[0])

    gray = (
        0.299 * bg_u8[:, :, 0]
        + 0.587 * bg_u8[:, :, 1]
        + 0.114 * bg_u8[:, :, 2]
    ).astype(np.float32)

    max_cx = bg_u8.shape[1] - span
    min_cx = max(0, x0)

    tm_x, tm_score = None, 0.0
    if cv2 is not None:
        piece = piece_rgba[y0:y1, x0:x1, :3]
        piece_mask = shape.astype(np.uint8) * 255
        # Restrict vertical search to the ypos band — full-frame TM picks wrong y.
        y_lo = max(0, row0 - 8)
        y_hi = min(bg_u8.shape[0], row0 + patch_h + 8)
        band = bg_u8[y_lo:y_hi, :]
        try:
            res = cv2.matchTemplate(band, piece, cv2.TM_CCORR_NORMED, mask=piece_mask)
            _, max_val, _, max_loc = cv2.minMaxLoc(res)
            tm_x = int(max_loc[0])
            tm_score = float(max_val)
            tm_y = y_lo + int(max_loc[1])
        except Exception:
            tm_x, tm_score, tm_y = None, 0.0, None
    else:
        tm_y = None

    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    gx[1:-1, 1:-1] = (
        -gray[:-2, :-2]
        + gray[:-2, 2:]
        - 2 * gray[1:-1, :-2]
        + 2 * gray[1:-1, 2:]
        - gray[2:, :-2]
        + gray[2:, 2:]
    )
    gy[1:-1, 1:-1] = (
        -gray[:-2, :-2]
        - 2 * gray[:-2, 1:-1]
        - gray[:-2, 2:]
        + gray[2:, :-2]
        + 2 * gray[2:, 1:-1]
        + gray[2:, 2:]
    )
    edges = np.sqrt(gx * gx + gy * gy)
    # Darkness under the piece silhouette: Geetest leaves a dark notch.
    # Collect every x so we can measure how decisive the winner is.
    dark_scores: list[tuple[int, float]] = []
    edge_scores: list[tuple[int, float]] = []
    for cx in range(min_cx, max_cx + 1):
        window = gray[row0:row0 + patch_h, cx:cx + span]
        vals = window[shape]
        if vals.size < 50:
            continue
        dark_scores.append((cx, float(vals.mean())))
        e = edges[row0:row0 + patch_h, cx:cx + span][shape]
        edge_scores.append((cx, float(e.mean())))
    if not dark_scores:
        raise RuntimeError("no gap candidates")

    dark_scores.sort(key=lambda kv: kv[1])
    best_dark, best_dark_v = dark_scores[0]
    second_v = dark_scores[1][1] if len(dark_scores) > 1 else best_dark_v
    # Larger gap between best and second => more confident dark hole.
    dark_margin = second_v - best_dark_v

    edge_scores.sort(key=lambda kv: -kv[1])
    best_edge = edge_scores[0][0]

    # Darkness is primary; edge breaks near-ties. TM only agrees/overrides
    # when its raw score is high AND it sits near the dark winner — never
    # let CCORR's bright-region false positives beat a clear dark notch.
    target = best_dark
    if abs(best_edge - best_dark) <= 10 and best_edge != best_dark:
        target = int(round((best_dark + best_edge) / 2))
    if (
        tm_x is not None
        and tm_score >= 0.85
        and abs(tm_x - target) <= 16
        and (tm_y is None or abs(tm_y - row0) <= 12)
    ):
        target = int(round((target + tm_x) / 2))
    log(
        f"[mimo-login] geetest gap dark={best_dark}(v={best_dark_v:.1f} "
        f"margin={dark_margin:.1f}) edge={best_edge} tm={tm_x}"
        f"({tm_score:.2f}@y={tm_y}) ypos={ypos} row0={row0} y0={y0} -> {target}"
    )
    return int(target), float(x0)


def solve_geetest_slide(page, max_attempts: int = 3) -> bool:
    """Port of the skill Aliyun slide solvers to Xiaomi's Geetest widget."""
    try:
        import numpy as np
        from PIL import Image
    except Exception as exc:
        log(f"[mimo-login] geetest deps missing: {exc}")
        return False

    for attempt in range(1, max_attempts + 1):
        if not geetest_visible(page):
            return True
        frame = geetest_frame(page)
        log(f"[mimo-login] geetest auto-solve attempt {attempt}/{max_attempts}")
        try:
            ready = geetest_images_ready(frame, timeout_s=4.0)
            if not ready and not (
                GEETEST_ASSETS.get("bg_path")
                or GEETEST_ASSETS.get("slice_path")
                or GEETEST_ASSETS.get("bg_bytes")
                or GEETEST_ASSETS.get("slice_bytes")
            ):
                raise RuntimeError("captcha images not ready")
            bg_bytes = None
            sl_bytes = None
            if ready:
                bg_bytes = _locator_image_bytes(
                    page, frame,
                    (".geetest_canvas_bg", ".geetest_bg", ".geetest_pic", ".geetest_picture",
                     "canvas[id*='bg']", "img[class*='bg']"),
                )
                sl_bytes = _locator_image_bytes(
                    page, frame,
                    (".geetest_canvas_slice", ".geetest_slice", ".geetest_block",
                     ".geetest_pic_slice", "canvas[id*='slice']", "img[class*='slice']"),
                )
            if not bg_bytes or not sl_bytes:
                bg_bytes, sl_bytes = _fetch_geetest_network_assets(page)
            if not bg_bytes or not sl_bytes:
                # One more try after a short wait for network/canvas paint.
                page.wait_for_timeout(800)
                if ready and not bg_bytes:
                    bg_bytes = _locator_image_bytes(
                        page, frame,
                        (".geetest_canvas_bg", ".geetest_bg", ".geetest_pic",
                         "canvas[class*='bg']", "canvas[id*='bg']"),
                    )
                if ready and not sl_bytes:
                    sl_bytes = _locator_image_bytes(
                        page, frame,
                        (".geetest_canvas_slice", ".geetest_slice", ".geetest_block",
                         "canvas[class*='slice']", "canvas[id*='slice']"),
                    )
                if not bg_bytes or not sl_bytes:
                    bg_bytes, sl_bytes = _fetch_geetest_network_assets(page)
            if not bg_bytes or not sl_bytes:
                raise RuntimeError(
                    "could not extract captcha images "
                    f"(bg_path={GEETEST_ASSETS.get('bg_path')!r} "
                    f"slice_path={GEETEST_ASSETS.get('slice_path')!r} "
                    f"bg_net={bool(GEETEST_ASSETS.get('bg_bytes'))} "
                    f"slice_net={bool(GEETEST_ASSETS.get('slice_bytes'))})"
                )
            bg = np.asarray(Image.open(io.BytesIO(bg_bytes)).convert("RGB"), dtype=np.uint8)
            pz = np.asarray(Image.open(io.BytesIO(sl_bytes)).convert("RGBA"), dtype=np.uint8)
            ypos = GEETEST_ASSETS.get("ypos")
            try:
                ypos_i = int(ypos) if ypos is not None else None
            except Exception:
                ypos_i = None
            target_x, piece_left = _geetest_hole_x(bg, pz, ypos=ypos_i)
            mask = pz[:, :, 3] > 24
            piece_px_width = int(np.where(mask)[1].max() - np.where(mask)[1].min() + 1)
            try:
                art = os.path.dirname(os.path.abspath(__file__)) + "/artifacts"
                os.makedirs(art, exist_ok=True)
                from PIL import ImageDraw
                dbg = Image.open(io.BytesIO(bg_bytes)).convert("RGB")
                d = ImageDraw.Draw(dbg)
                d.line([(target_x, 0), (target_x, dbg.height)], fill=(255, 0, 0), width=2)
                d.line([(int(piece_left), 0), (int(piece_left), dbg.height)], fill=(0, 255, 0), width=1)
                dbg.save(os.path.join(art, "gt-bg.png"))
                Image.open(io.BytesIO(sl_bytes)).save(os.path.join(art, "gt-slice.png"))
            except Exception:
                pass
            log(
                f"[mimo-login] geetest imgs bg={bg.shape[1]}x{bg.shape[0]} "
                f"slice={pz.shape[1]}x{pz.shape[0]} piece_w={piece_px_width} ypos={ypos_i}"
            )

            bg_box = None
            for sel in (".geetest_canvas_bg", ".geetest_bg", ".geetest_windows", ".geetest_pic", ".geetest_panel"):
                try:
                    bg_box = frame.locator(sel).first.bounding_box()
                    if bg_box and bg_box.get("width"):
                        break
                except Exception:
                    continue
            slider_loc = frame.locator(".geetest_btn").first
            if not slider_loc.count():
                slider_loc = frame.locator(".geetest_slider .geetest_btn, .geetest_slider_button").first
            track_loc = frame.locator(".geetest_slider").first
            if not slider_loc.count() or not bg_box:
                raise RuntimeError("captcha geometry incomplete")
            slider_box = slider_loc.bounding_box()
            track_box = track_loc.bounding_box() if track_loc.count() else None
            if not slider_box:
                raise RuntimeError("no slider box")
            if not track_box:
                track_box = {"x": slider_box["x"], "y": slider_box["y"] + 4,
                             "width": max(180.0, bg_box["width"]), "height": max(12.0, slider_box["height"])}
            scale_x = bg_box["width"] / max(1, bg.shape[1])
            # Hole left in display space relative to the image's left edge.
            target_display_x = max(0.0, (target_x - piece_left) * scale_x)
            max_travel = max(20.0, track_box["width"] - slider_box["width"] - 2)
            piece_display = piece_px_width * scale_x
            piece_span = max(1.0, bg_box["width"] - piece_display)
            # Handle travel so the piece moves `target_display_x` px.
            # Rail maps [0, max_travel] -> piece [0, piece_span].
            gain = float(np.clip(piece_span / max(max_travel, 1.0), 0.35, 1.35))
            needed = max(0.0, min(max_travel, target_display_x * max_travel / piece_span))
            log(
                f"[mimo-login] geetest gap target_x={target_x} piece_left={piece_left} "
                f"display={target_display_x:.1f} travel={max_travel:.1f} gain={gain:.2f} "
                f"needed={needed:.1f} bg_box={bg_box} track={track_box} slider={slider_box}"
            )

            start_x = slider_box["x"] + min(14.0, slider_box["width"] / 2)
            start_y = slider_box["y"] + slider_box["height"] / 2
            # needed already = target_display * max_travel / piece_span (above).
            if needed < 8:
                needed = min(max_travel, target_display_x)

            page.mouse.move(start_x - random.uniform(2, 6), start_y + random.uniform(-2, 2), steps=3)
            page.wait_for_timeout(random.randint(90, 200))
            page.mouse.move(start_x, start_y, steps=6)
            page.wait_for_timeout(random.randint(100, 240))
            page.mouse.down()
            page.wait_for_timeout(random.randint(70, 160))

            mouse = 0.0
            n_steps = max(16, min(48, int(needed / random.uniform(3.5, 5.5)) + random.randint(8, 20)))
            hesitations = set(random.sample(range(3, max(4, n_steps - 3)), k=random.choice([1, 1, 2])))
            y_drift = 0.0
            for s in range(1, n_steps + 1):
                t = s / n_steps
                eased = 3 * t * t - 2 * t * t * t
                noise = random.uniform(-0.018, 0.018) * needed
                target_pos = needed * eased + noise
                # Never reverse after mid-drag — noise can go negative.
                if s > 1 and target_pos < mouse:
                    target_pos = mouse + abs(noise) * 0.15
                mouse = target_pos
                y_drift += random.uniform(-0.9, 0.9)
                y_drift = max(-3.5, min(3.5, y_drift))
                page.mouse.move(start_x + mouse, start_y + y_drift + random.uniform(-0.7, 0.7))
                if s in hesitations:
                    page.wait_for_timeout(random.randint(110, 300))
                else:
                    page.wait_for_timeout(6 + int(28 * t * t) + random.randint(0, 12))

            # Closed-loop: read slice translateX and correct before release.
            def _slice_tx() -> float | None:
                try:
                    val = frame.evaluate(
                        """() => {
                          for (const sel of ['.geetest_canvas_slice', '.geetest_slice', '.geetest_block']) {
                            const el = document.querySelector(sel);
                            if (!el) continue;
                            const t = getComputedStyle(el).transform || getComputedStyle(el).webkitTransform || '';
                            const m = t.match(/matrix\\(([^)]+)\\)/);
                            if (m) return parseFloat(m[1].split(',')[4]) || 0;
                            const t2 = t.match(/translateX\\(([-0-9.]+)px\\)/);
                            if (t2) return parseFloat(t2[1]) || 0;
                            const left = parseFloat(getComputedStyle(el).left);
                            if (!Number.isNaN(left)) return left;
                          }
                          return null;
                        }"""
                    )
                    return None if val is None else float(val)
                except Exception:
                    return None

            tx0 = _slice_tx()
            log(f"[mimo-login] geetest slice tx after main drag={tx0}")
            # Map expected piece tx -> handle offset (same gain math).
            expected_tx = target_display_x
            if tx0 is not None:
                # tx is already in CSS px on the slice; compare to display target.
                err = expected_tx - tx0
                if abs(err) > 2.0:
                    # Convert piece-space error to handle nudge via gain.
                    gain_eff = piece_span / max(max_travel, 1.0)
                    nudge = err / max(gain_eff, 0.05)
                    nudge = max(-40.0, min(40.0, nudge))
                    page.mouse.move(
                        start_x + mouse + nudge,
                        start_y + random.uniform(-1.0, 1.0),
                        steps=4,
                    )
                    mouse = mouse + nudge
                    page.wait_for_timeout(random.randint(120, 240))
                    tx1 = _slice_tx()
                    log(f"[mimo-login] geetest closed-loop nudge={nudge:.1f} tx {tx0}->{tx1}")

            if needed > 16:
                overshoot = random.uniform(2.0, 6.0)
                page.mouse.move(
                    start_x + mouse + overshoot,
                    start_y + y_drift + random.uniform(-0.6, 0.6),
                    steps=random.randint(2, 4),
                )
                page.wait_for_timeout(random.randint(70, 150))
                back = overshoot
                while back > 0.8:
                    back -= random.uniform(1.0, 3.0)
                    page.mouse.move(start_x + mouse + max(0.0, back), start_y + y_drift + random.uniform(-0.5, 0.5))
                    page.wait_for_timeout(random.randint(30, 90))
                page.mouse.move(start_x + mouse, start_y + y_drift)
            page.wait_for_timeout(random.randint(250, 550))
            page.mouse.up()
            page.wait_for_timeout(2500)

            if not geetest_visible(page):
                log("[mimo-login] geetest auto-solved")
                save_screenshot(page, os.path.join(os.path.dirname(__file__), "artifacts"),
                                "geetest-solved.png")
                return True
            tx_after = _slice_tx()
            log(f"[mimo-login] geetest still visible after drag slice_tx={tx_after}")
            save_screenshot(page, os.path.join(os.path.dirname(__file__), "artifacts"),
                            f"geetest-attempt{attempt}.png")
            # Wait for the widget to swap in a fresh puzzle (auto or via refresh).
            for sel in (".geetest_refresh", ".geetest_btn_refresh", ".geetest_reset"):
                try:
                    btn = frame.locator(sel).first
                    if btn.count() and btn.is_visible(timeout=300):
                        btn.click(timeout=1500, force=True)
                        page.wait_for_timeout(2000)
                        break
                except Exception:
                    continue
            page.wait_for_timeout(800)
        except Exception as exc:
            log(f"[mimo-login] geetest attempt {attempt} error: {exc}")
            try:
                save_screenshot(page, os.path.join(os.path.dirname(__file__), "artifacts"),
                                f"geetest-err{attempt}.png")
            except Exception:
                pass
        page.wait_for_timeout(800)
    return False


def loading_identity_page(page) -> bool:
    """identity/authStart spinner — wait, do not treat as a finished challenge."""
    try:
        text = page_text(page).strip()
        url = (page.url or "").lower()
        if "just a sec" in text.lower() or text.lower() in ("", "loading…", "loading..."):
            if "identity" in url or "authstart" in url or not text:
                return True
        if "identity/authstart" in url and len(text) < 80:
            return True
    except Exception:
        pass
    return False


def wait_identity_ready(page, timeout_s: float = 20.0) -> bool:
    """After Geetest, identity page needs a beat before email UI appears."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if not loading_identity_page(page):
            return True
        page.wait_for_timeout(400)
    return not loading_identity_page(page)


def challenge_page_visible(page) -> bool:
    try:
        if email_verification_visible(page):
            return True
        if geetest_visible(page):
            return True
        text = page_text(page)
        lowered = text.lower()
        return any(m in text for m in (
            "需要安全验证",
            "安全验证",
            "验证失败",
            "短信",
            "邮箱验证码",
            "滑动验证",
            "拖动",
            "身份验证",
            "请输入验证码",
            "Account Authentication",
            "Send verification code",
        )) or any(m in lowered for m in (
            "captcha",
            "identity verification",
            "security verification",
            "verify your identity",
            "send verification code",
            "account authentication",
            "geetest",
            "slide the slider",
        ))
    except Exception:
        return False


def fill_and_submit(page, email: str, password: str) -> bool:
    dismiss_cookie_banner(page)

    # Xiaomi FE uses input[name=account] + input[name=password]
    email_loc = page.locator("input[name='account']").first
    pass_loc = page.locator("input[name='password']").first
    if not email_loc.count():
        for sel in (
            "input[type='text']",
            "input[placeholder*='账号']",
            "input[placeholder*='邮箱']",
            "input[placeholder*='手机']",
        ):
            cand = page.locator(sel).first
            if cand.count() and cand.is_visible(timeout=300):
                email_loc = cand
                break
    if not pass_loc.count():
        cand = page.locator("input[type='password']").first
        if cand.count():
            pass_loc = cand

    if not email_loc.count() or not pass_loc.count():
        return False

    # Floating mi-label intercepts normal clicks; fill() / force click bypass it.
    try:
        email_loc.fill(email, timeout=3000, force=True)
    except Exception:
        try:
            email_loc.fill(email, timeout=3000)
        except Exception:
            return False
    page.wait_for_timeout(200)

    try:
        pass_loc.fill(password, timeout=3000, force=True)
    except Exception:
        try:
            pass_loc.fill(password, timeout=3000)
        except Exception:
            return False
    page.wait_for_timeout(300)

    # Ensure agreement checkbox if present and required
    try:
        boxes = page.locator("input[type='checkbox']")
        for i in range(boxes.count()):
            box = boxes.nth(i)
            if box.is_visible(timeout=200) and not box.is_checked():
                # Only tick agreement-like boxes next to 协议 / agree text
                label = ""
                try:
                    label = box.evaluate(
                        "el => (el.closest('label')?.innerText || el.parentElement?.innerText || '')[:80]"
                    )
                except Exception:
                    pass
                low = label.lower()
                if (
                    "协议" in label
                    or "privacy" in low
                    or "agree" in low
                    or "terms" in low
                    or "policy" in low
                ):
                    box.check(timeout=1000)
    except Exception:
        pass

    submit = page.locator("button[type='submit']").first
    if not submit.count():
        for sel in (
            "button:has-text('登录')",
            "button:has-text('登 录')",
            "button:has-text('Sign in')",
            "button:has-text('Log in')",
            "button:has-text('Continue')",
            "button:has-text('Next')",
        ):
            cand = page.locator(sel).first
            if cand.count():
                submit = cand
                break
    if submit.count():
        try:
            if submit.is_enabled(timeout=2000):
                submit.click(timeout=3000)
                page.wait_for_timeout(400)
                # Post-submit agreement tip blocks the passport round-trip.
                accept_agreement_modal(page)
                return True
        except Exception:
            pass
        # Force-enable is not possible; still try Enter
    try:
        pass_loc.press("Enter")
        page.wait_for_timeout(400)
        accept_agreement_modal(page)
        return True
    except Exception:
        return False


def complete_cookies(jar: dict) -> bool:
    return bool(jar.get("service_token") and jar.get("user_id") and jar.get("ph_token"))


def try_finish_sso(context, page) -> dict | None:
    """If passport auth landed without mimo cookies, mint sid=xiaomichatbot via SSO."""
    jar = harvest(context)
    if complete_cookies(jar):
        return visit_home(context, page)
    names = set(jar.get("cookie_names") or [])
    raw = {c.get("name") for c in context.cookies()}
    if "passToken" not in raw and "passToken" not in names and "userId" not in raw:
        return None
    if geetest_visible(page):
        return None
    if email_code_input_visible(page) or email_verification_visible(page):
        return None
    if loading_identity_page(page):
        return None
    log(f"[mimo-login] incomplete mimo cookies — trying serviceLogin SSO cookies={sorted(names)[:24]}")
    done = try_service_sso(context, page)
    if done is not None and complete_cookies(done):
        return done
    jar = harvest(context)
    if complete_cookies(jar):
        return visit_home(context, page)
    return None


def try_service_sso(context, page) -> dict | None:
    """With passToken set, mint a service ticket for sid=xiaomichatbot via serviceLogin."""
    callback = "https%3A%2F%2Faistudio.xiaomimimo.com%2Fsts"
    json_url = (
        f"https://account.xiaomi.com/pass/serviceLogin"
        f"?sid=xiaomichatbot&callback={callback}&_json=true&_locale=zh_CN"
    )
    html_url = (
        f"https://account.xiaomi.com/pass/serviceLogin"
        f"?sid=xiaomichatbot&callback={callback}&_locale=zh_CN"
    )
    try:
        page.goto(json_url, wait_until="domcontentloaded", timeout=20000)
        page.wait_for_timeout(700)
        body = (page_text(page) or "").strip()
        loc = None
        code = None
        try:
            data = json.loads(body)
            if isinstance(data, dict):
                code = data.get("code")
                loc = data.get("location") or data.get("url")
        except json.JSONDecodeError:
            pass
        log(f"[mimo-login] serviceLogin json code={code} has_loc={bool(loc)}")
        jar = harvest(context)
        if complete_cookies(jar):
            return visit_home(context, page)
        if loc and str(loc).startswith("http"):
            page.goto(str(loc), wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(2000)
            jar = harvest(context)
            if complete_cookies(jar):
                return visit_home(context, page)
        # Browser redirect chain without _json (FE may complete the exchange).
        page.goto(html_url, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(2500)
        jar = harvest(context)
        if complete_cookies(jar):
            return visit_home(context, page)
        return None
    except Exception as exc:
        log(f"[mimo-login] service sso failed: {exc}")
        return None


def visit_home(context, page) -> dict:
    try:
        page.goto(MIMO_HOME_APP, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(2000)
    except Exception:
        pass
    return harvest(context)


def management_headers(args) -> dict:
    secret = (args.management_secret or "").strip() or "admin123"
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {secret}",
    }


def management_request(args, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    import urllib.error
    import urllib.request

    url = f"{args.management_url.rstrip('/')}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=management_headers(args))
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode() or "{}"
            return resp.status, json.loads(raw)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode() or "{}"
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = {"raw": raw[:400]}
        return exc.code, parsed
    except Exception as exc:
        return 0, {"error": str(exc)}


def resolve_account_id(args) -> str:
    if args.account_id:
        return args.account_id

    status, payload = management_request(args, "GET", "/v0/management/providers/mimo/accounts")
    if status != 200:
        raise RuntimeError(f"list mimo accounts failed: HTTP {status} {payload}")

    accounts = payload.get("data") or []
    email_l = args.email.strip().lower()
    for account in accounts:
        if str(account.get("email") or "").strip().lower() == email_l:
            return str(account.get("id") or "")

    name = args.account_name or f"mimo-{email_l.split('@')[0][:40]}"
    status, created = management_request(
        args,
        "POST",
        "/v0/management/accounts",
        {
            "providerId": "mimo",
            "name": name,
            "email": args.email,
            "credentials": {},
        },
    )
    if status not in (200, 201):
        raise RuntimeError(f"create mimo account failed: HTTP {status} {created}")
    account_id = str((created.get("data") or {}).get("id") or "")
    if not account_id:
        raise RuntimeError(f"create mimo account returned no id: {created}")
    return account_id


def update_management(args, jar: dict) -> dict:
    """PUT harvested cookies (and email/password) onto the mimo account."""
    if args.no_import:
        return {"imported": False, "reason": "no-import"}

    account_id = resolve_account_id(args)
    status, existing_payload = management_request(
        args,
        "GET",
        f"/v0/management/accounts/{account_id}?includeCredentials=true",
    )
    if status != 200:
        raise RuntimeError(f"load account {account_id} failed: HTTP {status} {existing_payload}")

    existing_account = existing_payload.get("data") or {}
    existing_credentials = existing_account.get("credentials") or {}
    # PUT replaces the whole credentials object — keep any extra fields.
    credentials = dict(existing_credentials)
    credentials.update({
        "service_token": jar["service_token"],
        "user_id": jar["user_id"],
        "ph_token": jar["ph_token"],
        "email": args.email,
        "password": args.password,
    })

    status, result = management_request(
        args,
        "PUT",
        f"/v0/management/accounts/{account_id}",
        {
            "email": args.email,
            "status": "active",
            "errorMessage": "",
            "credentials": credentials,
        },
    )
    if status != 200:
        raise RuntimeError(f"update account {account_id} failed: HTTP {status} {result}")
    print(f"[mimo-login] imported cookies into account {account_id}", file=sys.stderr)
    return {"imported": True, "account_id": account_id}


def code_error_visible(page) -> bool:
    try:
        text = page_text(page)
        # Only hard-failure copy. Do NOT match UI chrome like 重新发送 (resend link)
        # which is always present on the code-entry page.
        return any(m in text for m in (
            "验证码错误", "验证码不正确", "验证码错误或已失效",
            "验证码已失效", "验证码已过期",
            "错误次数过多", "尝试次数过多", "操作过于频繁",
            "请获取新的验证码", "验证码无效",
            "invalid verification", "verification code is incorrect",
            "verification code has expired",
        ))
    except Exception:
        return False


def http_error_page(page) -> bool:
    try:
        if (page.url or "").startswith("chrome-error:"):
            return True
        text = page_text(page)
        return "HTTP ERROR" in text or "该网页无法正常运作" in text
    except Exception:
        return (page.url or "").startswith("chrome-error:")


def recover_error_page(context, page) -> None:
    """After STS/aistudio 401 or chrome-error, navigate back to a stable page."""
    try:
        jar = harvest(context)
        names = jar.get("cookie_names", [])
        log(
            "[mimo-login] error page "
            f"url={page.url} cookies={names}"
        )
        if complete_cookies(jar):
            page.goto(MIMO_HOME_APP, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(1500)
            return
        # passToken already minted — try serviceLogin SSO before restarting password.
        raw = {c.get("name") for c in context.cookies()}
        if "passToken" in raw or "userId" in raw:
            done = try_service_sso(context, page)
            if done is not None:
                return
            try:
                if not http_error_page(page):
                    return
            except Exception:
                pass
        # chrome-error / 401: return via MiMo Sign in entry first (skill), then passport.
        try:
            page.goto(MIMO_HOME_APP, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(2000)
            if click_first(page, MIMO_LOGIN_SELECTORS):
                page.wait_for_timeout(2500)
                if wait_for_login_form(page, timeout_s=5):
                    return
        except Exception:
            pass
        page.goto(PASSPORT_LOGIN, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(1500)
    except Exception:
        pass


def await_post_submit(
    args,
    context,
    page,
    *,
    send_since_ms: int,
    timeout_s: int = 30,
) -> dict | None:
    """Poll after email-code submit: harvest cookies, recover errors, resend if rejected."""
    end = time.time() + timeout_s
    last_gmail_try = 0.0
    last_log = 0.0
    tried_codes: set[str] = set()
    recovered_errors = 0
    input_since = time.time()
    on_input = False
    last_sso_try = 0.0
    while time.time() < end:
        try:
            if loading_identity_page(page):
                page.wait_for_timeout(400)
                continue
            if agreement_modal_visible(page):
                accept_agreement_modal(page)
            jar = harvest(context)
            if complete_cookies(jar):
                jar = ensure_mimo_cookies(context, page)
                if complete_cookies(jar):
                    return jar
            now = time.time()
            if now - last_sso_try >= 6:
                last_sso_try = now
                finished = try_finish_sso(context, page)
                if finished and complete_cookies(finished):
                    return finished
            url = page.url or ""
            if http_error_page(page) and recovered_errors < 3:
                recovered_errors += 1
                save_screenshot(page, args.artifact_dir, "post-submit-401.png")
                # Transient chrome-error: give STS a moment / retry once first.
                if recovered_errors == 1:
                    page.wait_for_timeout(2000)
                    if not http_error_page(page):
                        continue
                    try:
                        page.reload(wait_until="domcontentloaded", timeout=15000)
                        page.wait_for_timeout(1500)
                        if not http_error_page(page):
                            jar = harvest(context)
                            if complete_cookies(jar):
                                jar = visit_home(context, page)
                                if complete_cookies(jar):
                                    return jar
                            continue
                    except Exception:
                        pass
                recover_error_page(context, page)
                continue
            if email_code_input_visible(page):
                if not on_input:
                    on_input = True
                    input_since = time.time()
                if code_error_visible(page) and (time.time() - input_since) > 1.5:
                    # Rejected — request a brand-new code.
                    log("[mimo-login] code rejected — requesting a new email code")
                    save_screenshot(page, args.artifact_dir, "code-rejected.png")
                    if start_email_verification(page):
                        send_since_ms = int(time.time() * 1000)
                        tried_codes.clear()
                        last_gmail_try = 0
                        input_since = time.time()
                        page.wait_for_timeout(800)
                        continue
                code = (args.email_code or "").strip()
                if not code and args.gmail_code:
                    now = time.time()
                    if now - last_gmail_try >= 3:
                        last_gmail_try = now
                        try:
                            code = fetch_gmail_email_code(args.email, send_since_ms, args=args)
                            if code:
                                log(f"[mimo-login] gmail code={code}")
                        except Exception as exc:
                            log(f"[mimo-login] gmail fetch failed: {exc}")
                if code and code not in tried_codes and not code_error_visible(page):
                    if fill_email_code(page, code):
                        tried_codes.add(code)
                        log(f"[mimo-login] filled email code {code}")
                        page.wait_for_timeout(1200)
                        continue
                elif code and code in tried_codes and (time.time() - input_since) > 8:
                    # Same code stuck — force resend.
                    if start_email_verification(page):
                        send_since_ms = int(time.time() * 1000)
                        tried_codes.clear()
                        input_since = time.time()
            else:
                on_input = False
                if email_verification_visible(page):
                    if start_email_verification(page):
                        send_since_ms = int(time.time() * 1000)
                        tried_codes.clear()
            now = time.time()
            if now - last_log >= 8:
                last_log = now
                log(f"[mimo-login] post-submit wait url={url[:180]}")
        except Exception as exc:
            log(f"[mimo-login] post-submit error: {exc}")
        page.wait_for_timeout(500)
    finished = try_finish_sso(context, page)
    if finished is not None and complete_cookies(finished):
        return finished
    jar = harvest(context)
    if complete_cookies(jar):
        jar = visit_home(context, page)
        if complete_cookies(jar):
            return jar
    return None


def wait_for_human_login(args, context, page, deadline_s: int | None = None) -> dict | None:
    """Leave the browser open so a human can fix password / enter email code."""
    timeout = deadline_s if deadline_s is not None else args.human_timeout
    log(
        "[mimo-login] waiting for human to finish login "
        f"(password, email code, or captcha; up to {timeout}s)..."
    )
    end = time.time() + timeout
    send_clicked = False
    code_ready = False
    prompted = False
    code_filled = False
    last_shot = 0.0
    send_since_ms = int(time.time() * 1000)
    last_gmail_try = 0.0
    last_fill_at = 0.0
    last_send_at = 0.0
    captcha_seen = False
    last_geetest_auto = 0.0
    tried_codes: set[str] = set()
    last_sso_try = 0.0
    while time.time() < end:
        try:
            if geetest_visible(page):
                if not captcha_seen:
                    captcha_seen = True
                    log("[mimo-login] geetest slide captcha visible — trying auto-solve")
                    save_screenshot(page, args.artifact_dir, "geetest.png")
                    if solve_geetest_slide(page, max_attempts=3):
                        if not geetest_visible(page):
                            log("[mimo-login] geetest passed during human-wait")
                            captcha_seen = False
                            continue
                    log("[mimo-login] geetest auto-solve failed — slide it in the open browser")
                else:
                    now = time.time()
                    if now - (last_geetest_auto or 0) >= 10:
                        last_geetest_auto = now
                        if solve_geetest_slide(page, max_attempts=1) and not geetest_visible(page):
                            log("[mimo-login] geetest passed on retry")
                            captcha_seen = False
                            continue
                page.wait_for_timeout(500)
                # Stay on passport; do not recover/navigate while captcha is up.
                jar = harvest(context)
                if complete_cookies(jar):
                    jar = ensure_mimo_cookies(context, page)
                    if complete_cookies(jar):
                        return jar
                if now_shot_due(last_shot):
                    last_shot = time.time()
                    save_screenshot(page, args.artifact_dir, "human-wait.png")
                continue
            if agreement_modal_visible(page):
                accept_agreement_modal(page)
            if http_error_page(page):
                recover_error_page(context, page)
            jar = harvest(context)
            if complete_cookies(jar):
                jar = ensure_mimo_cookies(context, page)
                if complete_cookies(jar):
                    return jar
            now = time.time()
            if not captcha_seen and now - last_sso_try >= 8:
                last_sso_try = now
                finished = try_finish_sso(context, page)
                if finished and complete_cookies(finished):
                    return finished
            code = (args.email_code or "").strip()
            if email_code_input_visible(page):
                if not code_ready:
                    code_ready = True
                    send_since_ms = min(send_since_ms, int(time.time() * 1000) - 120000)
                if code_error_visible(page) and (not tried_codes or time.time() - (last_fill_at or 0) > 6):
                    log("[mimo-login] code rejected — requesting a new email code")
                    if time.time() - last_send_at > 8 and start_email_verification(page):
                        last_send_at = time.time()
                        send_since_ms = int(time.time() * 1000)
                        tried_codes.clear()
                        last_gmail_try = 0
                        code_filled = False
                if not code and args.gmail_code:
                    now = time.time()
                    if now - last_gmail_try >= 3:
                        last_gmail_try = now
                        try:
                            code = fetch_gmail_email_code(args.email, send_since_ms, args=args)
                            if code:
                                log(f"[mimo-login] gmail code={code}")
                        except Exception as exc:
                            log(f"[mimo-login] gmail fetch failed: {exc}")
                if code and code not in tried_codes and not code_error_visible(page):
                    if fill_email_code(page, code):
                        tried_codes.add(code)
                        code_filled = True
                        last_fill_at = time.time()
                        log(f"[mimo-login] filled email code {code} and submitted")
                        post = await_post_submit(
                            args, context, page, send_since_ms=send_since_ms, timeout_s=25
                        )
                        if post:
                            return post
                        continue
            elif email_verification_visible(page):
                if (not send_clicked or code_filled) and time.time() - last_send_at > 8:
                    if start_email_verification(page):
                        last_send_at = time.time()
                        send_clicked = True
                        code_filled = False
                        tried_codes.clear()
                        send_since_ms = int(time.time() * 1000)
            if not prompted:
                if captcha_seen:
                    log(
                        "[mimo-login] waiting on geetest slide captcha — "
                        "drag the slider in the open browser, then OTP continues"
                    )
                elif code_ready:
                    log(
                        "[mimo-login] email code input ready — "
                        "fetching code from Gmail / enter manually if needed"
                    )
                elif send_clicked:
                    log(
                        "[mimo-login] email verification code requested — "
                        "will fetch from Gmail"
                    )
                else:
                    log(
                        "[mimo-login] waiting for login to finish — "
                        "password, captcha, or email code as needed"
                    )
                prompted = True
        except Exception:
            pass
        if not captcha_seen:
            jar = harvest(context)
            if complete_cookies(jar):
                jar = visit_home(context, page)
                if complete_cookies(jar):
                    return jar
            finished = try_finish_sso(context, page)
            if finished and complete_cookies(finished):
                return finished
        now = time.time()
        if now - last_shot >= 15:
            last_shot = now
            save_screenshot(page, args.artifact_dir, "human-wait.png")
        page.wait_for_timeout(1000)
    return None


def main() -> int:
    args = parse_args()
    headless = args.headless and not args.allow_human
    with sync_playwright() as pw:
        browser, context = launch(pw, headless=headless)
        page = context.new_page()

        # Do NOT install an async verifyEmail route — patchright sync can leave
        # the coroutine unawaited and identity/authStart hangs on "Just a sec…".
        # Response logging is handled by _on_auth_response below.

        def _on_auth_response(resp):
            try:
                _capture_geetest_assets(resp)
            except Exception:
                pass
            u = resp.url or ""
            interesting = any(k in u for k in (
                "/sts", "identity", "verifyEmail", "verify", "serviceLogin",
                "passToken", "serviceLoginAuth", "ticket", "secondAuth",
                "completeLogin", "loginSuccess", "sendEmailTicket",
            ))
            if not interesting:
                return
            extra = ""
            try:
                if 300 <= resp.status < 400:
                    extra = f" loc={(resp.headers or {}).get('location', '')!r}"
            except Exception:
                pass
            req = resp.request
            req_body = ""
            try:
                if req.method in ("POST", "PUT", "PATCH") and req.post_data:
                    req_body = f" req={req.post_data[:200]!r}"
            except Exception:
                pass
            if not (resp.status >= 400 or resp.status == 0 or 300 <= resp.status < 400
                    or "sts?" in u or "verify" in u.lower() or "identity" in u
                    or "serviceLoginAuth" in u):
                return
            body = ""
            try:
                raw = resp.body()
                if raw:
                    body = raw.decode("utf-8", errors="replace")[:400]
            except Exception as exc:
                body = f"<body err: {exc}>"
            if "gt/load" in u or "geetest" in body[:80].lower():
                return  # already captured above
            log(
                f"[mimo-login] auth resp {resp.status} {req.method} {u[:220]}"
                f"{req_body}{extra} body={body!r}"
            )

        page.on("response", _on_auth_response)
        try:
            # Skill entry: MiMo #/c → Sign in (service SSO) → passport fallback.
            if not enter_login_via_mimo(context, page):
                log("[mimo-login] login form not reachable via mimo/xiaomi entry")
            page = pick_page(context, page)
            page.wait_for_timeout(500)
            save_screenshot(page, args.artifact_dir, "01-load.png")

            if not fill_and_submit(page, args.email, args.password):
                # Already signed in, or form missing — fall through to harvest/human wait.
                jar = harvest(context)
                if complete_cookies(jar):
                    jar = ensure_mimo_cookies(context, page)
                    if complete_cookies(jar):
                        save_screenshot(page, args.artifact_dir, "success.png")
                        imported = update_management(args, jar)
                        emit({"kind": "ok", **jar, **imported})
                        return 0
                if args.allow_human or not headless:
                    jar = wait_for_human_login(args, context, page)
                    if jar:
                        save_screenshot(page, args.artifact_dir, "success-human.png")
                        imported = update_management(args, jar)
                        emit({"kind": "ok", **jar, **imported})
                        return 0
                emit({"kind": "error", "message": "login form not found", "url": page.url})
                save_screenshot(page, args.artifact_dir, "fail-form.png")
                return 1

            save_screenshot(page, args.artifact_dir, "02-submitted.png")

            deadline = time.time() + args.wait_seconds
            challenge_seen = False
            password_rejected = False
            while time.time() < deadline:
                if agreement_modal_visible(page):
                    accept_agreement_modal(page)
                    page.wait_for_timeout(400)

                text = page_text(page)
                jar = harvest(context)

                if complete_cookies(jar):
                    jar = ensure_mimo_cookies(context, page)
                    if complete_cookies(jar):
                        save_screenshot(page, args.artifact_dir, "success.png")
                        imported = update_management(args, jar)
                        emit({"kind": "ok", **jar, **imported})
                        return 0

                if challenge_page_visible(page):
                    challenge_seen = True
                    save_screenshot(page, args.artifact_dir, "challenge.png")
                    email_page = email_verification_visible(page)
                    captcha_now = geetest_visible(page)
                    send_since_ms = int(time.time() * 1000)
                    if captcha_now:
                        log("[mimo-login] geetest slide captcha — trying auto-solve")
                        if solve_geetest_slide(page, max_attempts=2):
                            captcha_now = geetest_visible(page)
                            if not captcha_now:
                                log("[mimo-login] geetest passed — waiting for identity page")
                                wait_identity_ready(page, timeout_s=15.0)
                                page.wait_for_timeout(800)
                                # Re-evaluate now that identity UI should be up.
                                email_page = email_verification_visible(page)
                                captcha_now = geetest_visible(page)
                    if email_page and not email_code_input_visible(page):
                        if start_email_verification(page):
                            send_since_ms = int(time.time() * 1000)
                    auto_deadline = time.time() + min(max(args.wait_seconds, 45), 90)
                    filled_codes: set[str] = set()
                    last_fill_at = 0.0
                    last_send_at = 0.0
                    last_geetest_try = 0.0
                    geetest_auto_failed = False
                    last_gmail_try = 0.0
                    while time.time() < auto_deadline:
                        jar = harvest(context)
                        if complete_cookies(jar):
                            jar = ensure_mimo_cookies(context, page)
                            if complete_cookies(jar):
                                save_screenshot(page, args.artifact_dir, "success.png")
                                imported = update_management(args, jar)
                                emit({"kind": "ok", **jar, **imported})
                                return 0
                        if loading_identity_page(page):
                            # Spinner: wait for the real identity/email UI.
                            page.wait_for_timeout(500)
                            continue
                        if geetest_visible(page):
                            # Stay put so the human can slide; never recover away.
                            now = time.time()
                            if not geetest_auto_failed and now - last_geetest_try >= 6:
                                last_geetest_try = now
                                if solve_geetest_slide(page, max_attempts=1):
                                    wait_identity_ready(page, timeout_s=12.0)
                                    continue
                                geetest_auto_failed = True
                                log("[mimo-login] geetest auto-solve failed — waiting for human")
                            page.wait_for_timeout(500)
                            continue
                        if agreement_modal_visible(page):
                            accept_agreement_modal(page)
                        if http_error_page(page):
                            recover_error_page(context, page)
                        if email_code_input_visible(page):
                            if code_error_visible(page) and time.time() - last_fill_at > 2:
                                log("[mimo-login] code rejected — requesting a new email code")
                                if time.time() - last_send_at > 8 and start_email_verification(page):
                                    last_send_at = time.time()
                                    send_since_ms = int(time.time() * 1000)
                                    filled_codes.clear()
                                    last_fill_at = 0.0
                                    page.wait_for_timeout(500)
                                    continue
                            code = (args.email_code or "").strip()
                            if not code and args.gmail_code:
                                now = time.time()
                                if now - last_gmail_try >= 3:
                                    last_gmail_try = now
                                    try:
                                        code = fetch_gmail_email_code(args.email, send_since_ms, args=args)
                                        if code:
                                            log(f"[mimo-login] gmail code={code}")
                                    except Exception as exc:
                                        log(f"[mimo-login] gmail fetch failed: {exc}")
                            if code and code not in filled_codes and not code_error_visible(page):
                                if fill_email_code(page, code):
                                    filled_codes.add(code)
                                    last_fill_at = time.time()
                                    log(f"[mimo-login] filled email code {code} and submitted")
                                    post = await_post_submit(
                                        args, context, page,
                                        send_since_ms=send_since_ms,
                                        timeout_s=30,
                                    )
                                    if post:
                                        save_screenshot(page, args.artifact_dir, "success.png")
                                        imported = update_management(args, post)
                                        emit({"kind": "ok", **post, **imported})
                                        return 0
                                    continue
                        elif email_verification_visible(page):
                            if time.time() - last_send_at > 8 and start_email_verification(page):
                                last_send_at = time.time()
                                send_since_ms = int(time.time() * 1000)
                                filled_codes.clear()
                        elif not challenge_page_visible(page) and "passport" not in (page.url or ""):
                            page.wait_for_timeout(400)
                        page.wait_for_timeout(400)
                    if args.allow_human or not headless:
                        jar = wait_for_human_login(args, context, page)
                        if jar:
                            save_screenshot(page, args.artifact_dir, "success-human.png")
                            imported = update_management(args, jar)
                            emit({"kind": "ok", **jar, **imported})
                            return 0
                    emit({
                        "kind": "error",
                        "message": "email verification required" if email_page
                        else "verification challenge required",
                        "text": page_text(page)[:400],
                        "url": page.url,
                        "partial": harvest(context),
                    })
                    return 2

                if any(m in text for m in (
                    "密码不正确", "密码错误", "账号或密码错误", "用户名或密码错误", "用户名或密码不正确",
                )):
                    password_rejected = True
                    save_screenshot(page, args.artifact_dir, "bad-password.png")
                    if args.allow_human or not headless:
                        # Do not exit: let the human correct credentials in the open tab.
                        jar = wait_for_human_login(args, context, page)
                        if jar:
                            save_screenshot(page, args.artifact_dir, "success-human.png")
                            imported = update_management(args, jar)
                            emit({"kind": "ok", **jar, **imported})
                            return 0
                    emit({"kind": "error", "message": "password rejected", "text": text[:400]})
                    return 3

                # Re-fill if form reset
                if page.locator("input[name='account']").count() and not page.locator(
                    "button[type='submit']"
                ).first.is_enabled():
                    try:
                        fill_and_submit(page, args.email, args.password)
                    except Exception:
                        pass

                page.wait_for_timeout(500)

            # Final sweep: modal may have appeared after the last poll.
            if agreement_modal_visible(page):
                accept_agreement_modal(page)
                page.wait_for_timeout(800)
                deadline2 = time.time() + min(args.wait_seconds, 20)
                while time.time() < deadline2:
                    jar = harvest(context)
                    if complete_cookies(jar):
                        jar = ensure_mimo_cookies(context, page)
                        if complete_cookies(jar):
                            save_screenshot(page, args.artifact_dir, "success.png")
                            imported = update_management(args, jar)
                            emit({"kind": "ok", **jar, **imported})
                            return 0
                    if agreement_modal_visible(page):
                        accept_agreement_modal(page)
                    page.wait_for_timeout(500)

            jar = harvest(context)
            if complete_cookies(jar):
                jar = ensure_mimo_cookies(context, page)
                if complete_cookies(jar):
                    save_screenshot(page, args.artifact_dir, "success.png")
                    imported = update_management(args, jar)
                    emit({"kind": "ok", **jar, **imported})
                    return 0
            if geetest_visible(page):
                if solve_geetest_slide(page, max_attempts=2) and not geetest_visible(page):
                    jar = harvest(context)
                    if complete_cookies(jar):
                        save_screenshot(page, args.artifact_dir, "success.png")
                        imported = update_management(args, jar)
                        emit({"kind": "ok", **jar, **imported})
                        return 0
            if geetest_visible(page) and (args.allow_human or not headless):
                # Do not bounce to MiMo home while captcha is still up.
                jar = wait_for_human_login(args, context, page)
                if jar:
                    save_screenshot(page, args.artifact_dir, "success-human.png")
                    imported = update_management(args, jar)
                    emit({"kind": "ok", **jar, **imported})
                    return 0
            jar = visit_home(context, page)
            save_screenshot(page, args.artifact_dir, "timeout.png")
            if complete_cookies(jar):
                imported = update_management(args, jar)
                emit({"kind": "ok", **jar, **imported})
                return 0
            if (args.allow_human or not headless) and not password_rejected:
                jar = wait_for_human_login(args, context, page)
                if jar:
                    save_screenshot(page, args.artifact_dir, "success-human.png")
                    imported = update_management(args, jar)
                    emit({"kind": "ok", **jar, **imported})
                    return 0
            emit({
                "kind": "error",
                "message": "cookie harvest timed out",
                "challenge": challenge_seen,
                "url": page.url,
                "text": page_text(page)[:400],
                "partial": jar,
            })
            return 4
        finally:
            try:
                browser.close()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
