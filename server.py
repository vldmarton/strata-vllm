"""Strata for vLLM - a local dashboard for vLLM inference servers.

Serves the static UI (web/) plus /api/metrics, which aggregates every second:
  - GPU stats via NVML (pynvml)
  - vLLM server stats from /v1/models, /v1/version and /metrics (Prometheus text)
  - host stats from /proc and psutil (CPU, RAM, disk)

The frontend polls /api/metrics once per second. No third-party UI framework.
"""
import asyncio
import json
import os
import re
import time
from collections import deque
from pathlib import Path

import psutil
import pynvml
import requests
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

PORT = int(os.environ.get("PORT", "8377"))
DATA_DIR = Path(os.environ.get("DATA_DIR", "/app/data"))
CONFIG_FILE = DATA_DIR / "config.json"
WEB_DIR = Path(__file__).parent / "web"

HISTORY_LEN = 60          # one sample per second, kept 60 s
MAX_REQUESTS = 50

app = FastAPI()


# ------------------------------------------------------------------ config
def load_config():
    try:
        return json.loads(CONFIG_FILE.read_text())
    except Exception:
        return {"backend": "", "key": ""}


def save_config(cfg):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2))


STATE = {
    "cfg": load_config(),
    "history": {k: deque(maxlen=HISTORY_LEN) for k in
                ("tok_s", "gpu", "vram", "temp", "power", "pcie", "cpu", "disk")},
    "requests": deque(maxlen=MAX_REQUESTS),
    "prev": {},            # counter bookkeeping for vLLM + host rates
    "last_sample": 0.0,
    "last_error": "",
    "vllm": {},            # slow-changing: model id, max_model_len, version
}


# ------------------------------------------------------------------ helpers
def vllm_get(path, timeout=2.5):
    cfg = STATE["cfg"]
    if not cfg.get("backend"):
        raise RuntimeError("no backend configured")
    base = cfg["backend"].rstrip("/")
    headers = {"Authorization": "***" + cfg["key"]} if cfg.get("key") else {}
    r = requests.get(base + path, headers=headers, timeout=timeout)
    r.raise_for_status()
    return r


def vllm_info():
    """Model id, max context and engine version. Fetched lazily / on change."""
    info = STATE["vllm"]
    if info.get("id"):
        return info
    models = vllm_get("/v1/models").json()["data"]
    info["id"] = models[0]["id"] if models else "unknown"
    info["max_ctx"] = (models[0].get("max_model_len") if models else None) or 0
    try:
        info["version"] = vllm_get("/v1/version", timeout=1.5).json().get("version", "")
    except Exception:
        info["version"] = ""
    return info


GaugeRe = re.compile(r"^vllm:([a-z_]+)\{([^}]*)\}\s+([\d.eE+-]+)\s*$")
GaugePlain = re.compile(r"^vllm:([a-z_]+)\s+([\d.eE+-]+)\s*$")
TypeRe = re.compile(r"^# TYPE (vllm:[a-z_]+) (counter|gauge|histogram|summary)")


def parse_metrics(text):
    """Collect the vLLM counters/gauges we need from Prometheus text."""
    out = {}
    types = {}
    for line in text.splitlines():
        m = TypeRe.match(line)
        if m:
            types[m.group(1)] = m.group(2)
            continue
        m = GaugePlain.match(line)
        if m and types.get(m.group(1)) in ("gauge", None):
            out.setdefault(m.group(1), float(m.group(2)))
            continue
        m = GaugeRe.match(line)
        if m:
            name, labels, value = m.group(1), m.group(2), float(m.group(3))
            if name.endswith("_bucket"):
                base = name[: -len("_bucket")]
                le = re.search(r'le="([^"]*)"', labels)
                if le:
                    out.setdefault(base + "__bucket__" + le.group(1), 0.0)
                    out[base + "__bucket__" + le.group(1)] = value
            elif name.endswith("_sum") or name.endswith("_count"):
                out[name] = value
            elif "engine" in labels or not labels:
                out.setdefault(name, value)
    return out


def counter_delta(key, m):
    """Delta of a monotonic counter since the last sample; None when unavailable."""
    prev = STATE["prev"]
    new = m.get(key)
    old = prev.get(key)
    if new is None:
        prev.pop(key, None)
        return None
    if old is None:
        prev[key] = new
        return None
    delta = new - old
    prev[key] = new
    return delta if delta >= 0 else 0.0


def _pcie_max_gen(h):
    # nvidia-ml-py renamed nvmlDeviceGetPcieLinkGen -> nvmlDeviceGetGpuMaxPcieLinkGeneration
    fn = getattr(pynvml, "nvmlDeviceGetGpuMaxPcieLinkGeneration", None)
    if fn is None:
        fn = pynvml.nvmlDeviceGetPcieLinkGen
    return fn(h)


def _pcie_width(h):
    # nvidia-ml-py renamed nvmlDeviceGetPcieLinkWidth -> nvmlDeviceGetCurrPcieLinkWidth
    fn = getattr(pynvml, "nvmlDeviceGetCurrPcieLinkWidth", None)
    if fn is None:
        fn = pynvml.nvmlDeviceGetPcieLinkWidth
    return fn(h)


def gpu_stats():
    """Per-GPU stats for every visible device; {} when NVML is unavailable."""
    if not NVML_OK:
        return {}
    out = {}
    try:
        count = pynvml.nvmlDeviceGetCount()
    except Exception:
        return {}
    for i in range(count):
        try:
            h = pynvml.nvmlDeviceGetHandleByIndex(i)
            mem = pynvml.nvmlDeviceGetMemoryInfo(h)
            util = pynvml.nvmlDeviceGetUtilizationRates(h)
            entry = {
                "name": pynvml.nvmlDeviceGetName(h),
                "util": util.gpu,
                "mem_used": mem.used,
                "mem_total": mem.total,
                "temp": pynvml.nvmlDeviceGetTemperature(h, pynvml.NVML_TEMPERATURE_GPU),
                "power": pynvml.nvmlDeviceGetPowerUsage(h) / 1000.0,
                "power_limit": pynvml.nvmlDeviceGetPowerManagementLimit(h) / 1000.0,
            }
            try:
                entry["pcie_gen_max"] = _pcie_max_gen(h)
            except Exception:
                entry["pcie_gen_max"] = None
            try:
                entry["pcie_width"] = _pcie_width(h)
            except Exception:
                entry["pcie_width"] = None
            try:
                entry["pcie_gen"] = pynvml.nvmlDeviceGetCurrPcieLinkGeneration(h)
            except Exception:
                entry["pcie_gen"] = entry["pcie_gen_max"]
            out[i] = entry
        except Exception:
            continue
    return out


def host_stats(dt):
    ram = psutil.virtual_memory()
    disk = psutil.disk_io_counters()
    prev = STATE["prev"]
    old_disk = prev.get("disk")
    read_rate = write_rate = None
    if disk and old_disk and dt > 0:
        read_rate = max(0.0, (disk.read_bytes - old_disk.read_bytes) / dt / 1e6)
        write_rate = max(0.0, (disk.write_bytes - old_disk.write_bytes) / dt / 1e6)
    prev["disk"] = disk
    return {
        "cpu": psutil.cpu_percent(None),
        "ram_used": ram.used,
        "ram_total": ram.total,
        "disk_read": read_rate,
        "disk_write": write_rate,
    }


# ------------------------------------------------------------------ sampling
def sample():
    cfg = STATE["cfg"]
    if not cfg.get("backend"):
        STATE["last_error"] = ""
        return
    now = time.monotonic()
    dt = now - STATE["last_sample"] if STATE["last_sample"] else None
    STATE["last_sample"] = now
    hist = STATE["history"]

    gpu, vllm_m, host = None, {}, None
    try:
        vllm_m = parse_metrics(vllm_get("/metrics").text)
    except Exception as e:
        STATE["last_error"] = f"backend unreachable: {e.__class__.__name__}"
    else:
        STATE["last_error"] = ""
    try:
        gpu = gpu_stats()
    except Exception:
        pass
    try:
        host = host_stats(dt) if dt else None
    except Exception:
        pass

    # vLLM-derived values
    running = vllm_m.get("num_requests_running")
    waiting = vllm_m.get("num_requests_waiting")
    kv = vllm_m.get("kv_cache_usage_perc")
    decode_tok_s, prefill_tok_s = None, None
    if dt:
        dec_n = counter_delta("request_decode_time_seconds_count", vllm_m)
        dec_t = counter_delta("request_decode_time_seconds_sum", vllm_m)
        if dec_n and dec_t and dec_t > 0:
            decode_tok_s = dec_n / dec_t
        ttft_n = counter_delta("time_to_first_token_seconds_count", vllm_m)
        ttft_t = counter_delta("time_to_first_token_seconds_sum", vllm_m)
        pmt = counter_delta("prompt_tokens_total", vllm_m)
        if ttft_n and ttft_t and ttft_t > 0 and pmt:
            prefill_tok_s = pmt / ttft_t
        pcie_n = counter_delta("estimated_read_bytes_per_gpu_total", vllm_m)
        pcie_mb = pcie_n / dt / 1e6 if pcie_n is not None else None
    else:
        pcie_mb = None
    counter_delta("generation_tokens_total", vllm_m)
    counter_delta("prefix_cache_hits_total", vllm_m)
    counter_delta("prefix_cache_queries_total", vllm_m)

    # a finished request: the per-request histograms each tick up by one completion
    if dt:
        done_n = counter_delta("request_success_total", vllm_m)
        if done_n and done_n >= 1:
            prompt = counter_delta("request_prompt_tokens_sum", vllm_m)
            out_tok = counter_delta("request_generation_tokens_sum", vllm_m)
            infl = counter_delta("request_inference_time_seconds_sum", vllm_m)
            prefill = counter_delta("request_prefill_time_seconds_sum", vllm_m)
            decode = counter_delta("request_decode_time_seconds_sum", vllm_m)
            cached = counter_delta("prompt_tokens_cached_total", vllm_m)
            if out_tok is not None and infl is not None:
                STATE["requests"].appendleft({
                    "time": time.time(),
                    "prompt": int(prompt or 0),
                    "reused": int(min(cached or 0, (prompt or 0))),
                    "output": int(out_tok),
                    "tok_s": (out_tok / decode) if decode and decode > 0 else None,
                    "prefill_s": prefill,
                    "duration": infl,
                })

    # slow-changing model info (re-fetch after a backend change or a fresh start)
    if not STATE["last_error"] and not STATE["vllm"].get("id"):
        try:
            vllm_info()
        except Exception:
            pass

    STATE["gpu"], STATE["vllm_m"], STATE["host"] = gpu, vllm_m, host
    g0 = gpu.get(0) if gpu else None
    STATE["live"] = {
        "running": running, "waiting": waiting, "kv": kv,
        "decode_tok_s": decode_tok_s, "prefill_tok_s": prefill_tok_s, "pcie_mb": pcie_mb,
    }
    if dt:  # first tick has no rate: don't pollute the sparklines with zeros
        hist["tok_s"].append(decode_tok_s)
        hist["gpu"].append(g0["util"] if g0 else None)
        hist["vram"].append(g0["mem_used"] if g0 else None)
        hist["temp"].append(g0["temp"] if g0 else None)
        hist["power"].append(g0["power"] if g0 else None)
        hist["pcie"].append(pcie_mb)
        hist["cpu"].append(host["cpu"] if host else None)
        hist["disk"].append(host["disk_read"] if host else None)

    STATE["prefix"] = {
        "hits": STATE["prev"].get("prefix_cache_hits_total"),
        "queries": STATE["prev"].get("prefix_cache_queries_total"),
    }


# ------------------------------------------------------------------ API
@app.get("/api/settings")
def get_settings():
    return {"backend": STATE["cfg"].get("backend", ""), "has_key": bool(STATE["cfg"].get("key"))}


@app.post("/api/settings")
def set_settings(body: dict):
    cfg = dict(STATE["cfg"])
    if "backend" in body:
        cfg["backend"] = str(body["backend"]).strip().rstrip("/")
    if body.get("key") is not None:
        cfg["key"] = str(body["key"]).strip()
    STATE["cfg"] = cfg
    save_config(cfg)
    STATE["vllm"] = {}          # the backend changed: re-fetch model info
    STATE["prev"] = {}          # counter history is meaningless across backends
    STATE["last_sample"] = 0.0
    for q in STATE["history"].values():
        q.clear()
    sample()
    return {"ok": True}


@app.get("/api/metrics")
def metrics():
    s = STATE
    gpu, host, m = s.get("gpu") or {}, s.get("host"), s.get("vllm_m", {})
    g0 = gpu.get(0)  # primary GPU (index 0) drives the headline cards
    live = s.get("live", {})
    info = s.get("vllm", {})
    prefix = s.get("prefix", {})

    if not s["cfg"].get("backend"):
        return JSONResponse({"state": "no_backend", "error": None})
    if s["last_error"]:
        return JSONResponse({"state": "error", "error": s["last_error"]})

    running, waiting, kv = live.get("running") or 0, live.get("waiting") or 0, live.get("kv")
    last_req = s["requests"][0] if s["requests"] else None
    decode = live.get("decode_tok_s")
    prefill = live.get("prefill_tok_s")
    speed = prefill if (prefill and not decode) else (decode if decode else (last_req["tok_s"] if last_req else None))
    speed_kind = "prefill" if (prefill and not decode) else ("decode" if decode else "last request")

    state = "generating" if running else "queued" if waiting else "idle"
    if running and prefill and not decode:
        state = "reading"
    if state == "generating":
        detail = f"Generating · {running} running" + (f" · {decode:.1f} tok/s" if decode else "")
    elif state == "reading":
        detail = f"Reading prompt · {running} running" + (f" · {prefill:,.0f} tok/s" if prefill else "")
    elif state == "queued":
        detail = f"{waiting} waiting"
    else:
        detail = (f"last: {last_req['output']:,} tokens at {last_req['tok_s']:.1f} tok/s"
                  if last_req and last_req["tok_s"] else "no requests yet")

    ctx = info.get("max_ctx") or 0
    used = int(kv * ctx) if kv is not None and ctx else 0

    reqs = []
    for r in list(s["requests"])[:30]:
        reqs.append({
            "time": r["time"], "prompt": r["prompt"], "reused": r["reused"],
            "output": r["output"], "tok_s": r["tok_s"], "duration": r["duration"],
        })

    return {
        "state": state,
        "detail": detail,
        "kv": kv,
        "model": {"id": info.get("id"), "version": info.get("version"), "max_ctx": ctx},
        "speed": speed,
        "speed_kind": speed_kind,
        "prefill": live.get("prefill_tok_s"),
        "gpu": {
            "name": g0["name"] if g0 else None,
            "util": g0["util"] if g0 else None,
            "mem_used": g0["mem_used"] if g0 else None,
            "mem_total": g0["mem_total"] if g0 else None,
            "temp": g0["temp"] if g0 else None,
            "power": g0["power"] if g0 else None,
            "power_limit": g0["power_limit"] if g0 else None,
            "pcie_gen": (g0.get("pcie_gen") or g0.get("pcie_gen_max")) if g0 else None,
            "pcie_gen_max": g0.get("pcie_gen_max") if g0 else None,
            "pcie_width": g0.get("pcie_width") if g0 else None,
            "pcie_mb": live.get("pcie_mb"),
            "count": len(gpu),
        },
        "gpus": [
            {
                "name": g["name"], "util": g["util"],
                "mem_used": g["mem_used"], "mem_total": g["mem_total"], "temp": g["temp"],
            }
            for g in gpu.values()
        ],
        "host": {
            "cpu": host["cpu"] if host else None,
            "cores": psutil.cpu_count(logical=False),
            "threads": psutil.cpu_count(logical=True),
            "ram_used": host["ram_used"] if host else None,
            "ram_total": host["ram_total"] if host else None,
            "disk_read": host["disk_read"] if host else None,
            "disk_write": host["disk_write"] if host else None,
        },
        "ctx_used": used,
        "prefix": {
            "hits": prefix.get("hits"), "queries": prefix.get("queries"),
            "rate": (prefix["hits"] / prefix["queries"])
                    if prefix.get("hits") is not None and prefix.get("queries") else None,
        },
        "requests": reqs,
        "history": {k: [None if v is None else round(v, 2) for v in s["history"][k]]
                    for k in s["history"]},
    }


# ------------------------------------------------------------------ start
try:
    pynvml.nvmlInit()
    NVML_OK = True
except Exception:
    NVML_OK = False
psutil.cpu_percent(None)  # prime the interval sampler

@app.on_event("startup")
async def _loop():
    async def ticker():
        while True:
            try:
                await asyncio.to_thread(sample)
            except Exception:
                pass
            await asyncio.sleep(1.0)
    asyncio.create_task(ticker())


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
